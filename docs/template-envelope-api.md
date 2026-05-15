# Template + Envelope API Recipe

How to programmatically place fields on a Reeve.Sign template, then create envelopes from that template with prefilled values.

**Audience:** consumer-app implementers (DEV-714's `bland-to-rep-agreement` workflow, future AgentPik / Freya / Reeve.Sign integrations).

**Companion scripts:**

- `scripts/dev-657-generate-placeholder-pdf.ts` — generates a labeled-line placeholder PDF
- `scripts/dev-657-setup-template-fields.ts` — places fields on a template via v2 API
- `scripts/dev-657-envelope-smoke.ts` — creates an envelope from a template with prefill

Use them as the executable spec. This doc explains the surface and the quirks the scripts work around.

---

## Auth

All requests use an **organisation API token** in the `Authorization` header. No `Bearer ` prefix.

```http
Authorization: api_xxxxxxxxxxxxxxxx
Content-Type: application/json
```

Tokens are minted in the Reeve.Sign UI under the organisation settings. They are organisation-scoped — they can act on any team the org owns. For multi-team orgs, the token's team scope is determined by the team the token was minted under.

Base URL: `https://sign.meetreeve.com` (override via `REEVE_SIGN_BASE_URL` in scripts).

## API surface — what we use

| Step | Method | Path | Purpose |
|---|---|---|---|
| Inspect template | `GET` | `/api/v2/template/{templateId}` | Get template title, teamId, recipients (with id/role), fields (with id + fieldMeta.label) |
| Place fields | `POST` | `/api/v2/template/field/create-many` | Bulk-create fields on a template |
| Delete a field | `POST` | `/api/v2/template/field/delete` | Remove one field (used by setup script's `FORCE=1` path) |
| Create envelope | `POST` | `/api/v2/template/use` | "Use template" → produce a document/envelope with optional prefill |
| Inspect envelope | `GET` | `/api/v2/document/{documentId}` | Verify prefill landed; read recipient tokens |

The full OpenAPI spec is served at `https://sign.meetreeve.com/api/v2/openapi.json` — fetch it whenever you're unsure about a payload shape.

---

## Coordinate systems

Reeve.Sign (Documenso) stores field positions as **percentages of the page, top-left origin**:

- `pageX`, `pageY` — top-left corner of the field, 0–100
- `width`, `height` — also percentages

Source PDFs typically use **points (pt), bottom-left origin** (1pt = 1/72in). To convert:

```ts
// PDF: (xPt, yPt) is the bottom-left of the field on a 612x792pt US Letter page
const PAGE_W = 612, PAGE_H = 792;
const topYPdf = yPt + heightPt;            // top of field in PDF coords
const pageX_pct = (xPt / PAGE_W) * 100;
const pageY_pct = ((PAGE_H - topYPdf) / PAGE_H) * 100;
const width_pct = (widthPt / PAGE_W) * 100;
const height_pct = (heightPt / PAGE_H) * 100;
```

See `scripts/dev-657-setup-template-fields.ts::toDocumensoCoords` for the production helper. It also offsets to sit a field's bottom edge on a label underline at `yPt - 4`.

---

## Field types & fieldMeta

Each field has a `type` and a `fieldMeta`. `fieldMeta.type` is the lowercased `type`. Required common keys:

```ts
fieldMeta: {
  label: string;        // human label shown in editor + audit log
  readOnly: boolean;    // if true, signer cannot edit
  required: boolean;    // if true, signer must complete (where applicable)
  type: 'text' | 'email' | 'number' | 'date' | 'dropdown' | 'signature' | 'radio' | 'checkbox';
  // ...type-specific extras
}
```

Type-specific extras seen in this repo's scripts:

- `text`: `text: string | undefined` (default value)
- `number`: `value: string | undefined` (default value, as a string)
- `dropdown`: `values: { value: string }[]` (list of options), optional `defaultValue`
- `date`: `required: false, readOnly: true` — signing date is auto-stamped at signature
- `signature`: `readOnly: false`

Use the snake_case key in `setup-template-fields.ts`'s `FIELD_LAYOUT[].id` as the canonical name. The smoke script's `FIELD_LABELS` maps those snake_case keys to the human label, which is the only field the v2 API exposes for label-based lookup.

---

## Recipe 1 — place fields on a template

```bash
REEVE_SIGN_API_TOKEN=api_xxx \
TEMPLATE_ID=1 \
npx tsx scripts/dev-657-setup-template-fields.ts
```

Idempotent on first write. Re-run with `FORCE=1` to delete existing fields and recreate from scratch.

Request shape (per field):

```json
{
  "recipientId": 5,
  "pageNumber": 1,
  "pageX": 5.88,
  "pageY": 17.42,
  "width": 42.48,
  "height": 2.53,
  "type": "TEXT",
  "fieldMeta": {
    "label": "Agent name",
    "type": "text",
    "readOnly": true,
    "required": true,
    "text": "Optional default value"
  }
}
```

POSTed in a batch as `{ templateId, fields: [...] }` to `/api/v2/template/field/create-many`. Response is `{ fields: [{ id, type }] }`.

> **Field IDs are global** — the `id`s returned here are document/envelope/template field ids in the same monotonic counter. Don't rely on field id 2 always being the first field in template 1 across environments.

---

## Recipe 2 — create envelope with prefill

```bash
REEVE_SIGN_API_TOKEN=api_xxx \
TEMPLATE_ID=1 \
CONSUMER_NAME="Jane Buyer" \
CONSUMER_EMAIL=jane@example.com \
npx tsx scripts/dev-657-envelope-smoke.ts
```

Two-step flow:

1. `GET /api/v2/template/{id}` → build `{label: fieldId}` map and find the signer recipient slot id
2. `POST /api/v2/template/use` with the prefill payload

Request body shape:

```json
{
  "templateId": 1,
  "distributeDocument": false,
  "recipients": [
    { "id": 5, "email": "jane@example.com", "name": "Jane Buyer" }
  ],
  "prefillFields": [
    { "id": 2,  "type": "text",     "value": "Alex Agent" },
    { "id": 7,  "type": "dropdown", "value": "SFH" },
    { "id": 9,  "type": "number",   "value": "90" }
  ]
}
```

- `recipients[].id` is the **template** recipient slot id (from the GET response). The server clones this slot into a document recipient when the template is used.
- `recipients[].email` and `recipients[].name` override the template placeholder values and populate any matching EMAIL field on the resulting document.
- `distributeDocument: false` keeps the envelope in `DRAFT` state with `sendStatus: NOT_SENT`. Set to `true` to actually email the signer. For workflows, prefer `false` here and explicitly call `/api/v2/envelope/distribute` (or send the signing URL yourself) once your post-create steps succeed.

Response (truncated to what you care about):

```json
{
  "id": 4,
  "envelopeId": "envelope_fcbtfcnobyttzkzr",
  "status": "DRAFT",
  "title": "Buyers Rep (CA - PLACEHOLDER - DO NOT USE) (copy)",
  "recipients": [
    {
      "id": 7,
      "role": "SIGNER",
      "email": "jane@example.com",
      "name": "Jane Buyer",
      "token": "aHqQ3YJxgF9MyAlL2wKzI"
    }
  ]
}
```

Construct the signing URL: `${baseUrl}/sign/${recipient.token}`.

---

## Prefill mechanics

Prefilled values are stored differently depending on field type. After `/template/use`, `GET /api/v2/document/{id}` returns each field with the prefill in one of these places:

| Field type   | Prefill variant     | Stored on document field at | Notes |
|---|---|---|---|
| `TEXT`       | `{ type: "text", value }`     | `customText` (string) | |
| `NUMBER`     | `{ type: "number", value }`   | `customText` (string) | value is a string in the prefill payload |
| `DROPDOWN`   | `{ type: "dropdown", value }` | `fieldMeta.defaultValue` (string) | **not** `customText` |
| `RADIO`      | `{ type: "radio", value }`    | `fieldMeta.defaultValue` | |
| `CHECKBOX`   | `{ type: "checkbox", value }` | `fieldMeta.defaultValue` | |
| `DATE`       | `{ type: "date", value }`     | `customText` | typically auto-stamped at sign |
| `EMAIL`      | *not supported* — see gotcha below | auto-filled from `recipients[i].email` at sign | |
| `SIGNATURE`  | *not supported* — filled at sign |  | |

If you build a UI that displays prefilled values, **read from both `customText` and `fieldMeta.defaultValue`** depending on the field type.

---

## Gotchas

### EMAIL fields cannot be prefilled

The v2 `prefillFields` schema's `oneOf` covers `text | number | radio | checkbox | dropdown | date` — there is **no `email` variant**. Sending `{ type: "text", value }` against an `EMAIL` field returns:

```json
{ "code": "INVALID_BODY", "message": "Field type mismatch for field N: expected email, got text" }
```

**Fix:** drop EMAIL fields from the prefill payload. The `recipients[].email` you pass at envelope-create time auto-fills any EMAIL field assigned to that recipient at signing time. The smoke script's `FIELD_LABELS` map intentionally omits the EMAIL field for this reason.

### SIGNATURE fields cannot be prefilled

Obviously. Drop them from prefill. They are filled at sign time.

### Field type strings differ between API levels

- Field-level: uppercase (`TEXT`, `EMAIL`, `DROPDOWN`, `NUMBER`, `DATE`, `SIGNATURE`)
- `fieldMeta.type`: lowercase (`text`, `email`, `dropdown`, `number`, `date`, `signature`)
- `prefillFields[].type`: lowercase

The setup script encodes both; the smoke script uses lowercase for prefill. If you copy a payload between contexts, recheck the casing.

### `pg sslmode=require` rejects RDS

Not Reeve.Sign-specific, but bites every Node service hitting the Reeve.Sign Postgres directly: Node `pg` v8.20+ treats `sslmode=require` as `verify-full` and rejects the AWS RDS CA chain. Use `sslmode=no-verify` instead. (Documented in `[[pg_sslmode_no_verify_for_rds]]`.)

### Label-based field lookup is fragile

The smoke script joins template fields to prefill payloads by `fieldMeta.label`. If a template's labels drift from the setup script's `FIELD_LAYOUT` (e.g., editor-side rename), prefill silently skips. For production usage, prefer one of:

1. Store the snake_case key in `fieldMeta.label` and never let it be renamed (the convention used here).
2. Embed the snake_case key in an undocumented field (e.g., `customText` — but that gets overwritten on prefill).
3. Persist a `{label → fieldId}` map at template-create time and pass field ids directly at envelope-create time.

DEV-714 should adopt approach #3 once it knows which template ids it owns.

### `templateId` and `recipients[].id` are different scopes

- `templateId` (in body): the template you're using. Numeric.
- `recipients[].id` (in body): the **template's** recipient slot id, from the GET response. The server clones the slot into a document recipient and returns the new id under `response.recipients[].id`. Don't reuse the response id when re-running against the template.

### Field ids in `prefillFields[].id` must be template field ids

Same caveat — they're the template's field ids (from `GET /api/v2/template/{id}`), not document field ids. The server clones the field set into the document at use time.

---

## Production wiring (DEV-714's concern)

When wiring this into the `bland-to-rep-agreement` workflow:

1. `REEVE_SIGN_API_TOKEN` lives in `reeve-agents/.env`. The token is `api_*` and stored only on the EC2 host; the workflow reads it from `process.env` at node entry.
2. `TEMPLATE_ID` is a per-tenant config — store it on the tenant record (`organisation_settings.rep_agreement_template_id` or similar) so other consumer apps can choose their own template without redeploys.
3. Use `distributeDocument: false` in `create-envelope`, then call your own `send-consumer-comms` node (SMS via Twilio + email via Reeve.Comms per [[feedback_route_comms_through_reeve_comms]]) with the constructed signing URL. This keeps the engagement copy under your control.
4. Persist `documentId` and `envelopeId` on the workflow state so the Documenso completion webhook can correlate back to the right thread.

See DEV-714 for the workflow shape and DEV-715 for the AgentPik backend wire-up.

---

## Related

- DEV-657 — Bland → rep-agreement auto-flow (parent epic)
- DEV-713 — this ticket (foundation)
- DEV-714 — workflow consuming this API
- DEV-715 — AgentPik webhook receiver + listener
- `[[reeve_sign_architecture_decision]]` — why AgentPik signing is a Reeve.Agents workflow
