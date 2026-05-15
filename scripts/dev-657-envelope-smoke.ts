// scripts/dev-657-envelope-smoke.ts
//
// Smokes the Reeve.Sign v2 "use template" flow end-to-end:
//   1. GET the template, build a label → fieldId lookup
//   2. POST /api/v2/template/use with the signer + prefill values
//   3. Print envelopeId + signing URL(s)
//
// This is the recipe DEV-714's `create-envelope` workflow node copies.
// Keep it in the repo as the executable spec.
//
// Run:
//   REEVE_SIGN_API_TOKEN=api_xxx TEMPLATE_ID=1 npx tsx scripts/dev-657-envelope-smoke.ts
//
// Env:
//   REEVE_SIGN_API_TOKEN   required — Bearer token (organisation-scoped)
//   TEMPLATE_ID            required — the templateId to use
//   REEVE_SIGN_BASE_URL    optional — defaults to https://sign.meetreeve.com
//   CONSUMER_NAME          optional — default "Jane Buyer (Smoke)"
//   CONSUMER_EMAIL         optional — default "matt+smoke-consumer@mindfortress.com"
//   AGENT_NAME             optional — default "Alex Agent (Smoke)"
//   AGENT_LICENSE          optional — default "DRE #01234567"
//   CONSUMER_PHONE         optional — default "+14155550100"
//   PROPERTY_TYPE          optional — default "SFH"      (must match a dropdown option)
//   SEARCH_AREA            optional — default "94110 / Mission, SF"
//   TERM_DAYS              optional — default 90
//   COMMISSION_PCT         optional — default 2.5
//   DISTRIBUTE             optional — "1" actually emails; default 0 = NONE (no email sent)

type TemplateField = {
  id: number;
  type: string;
  fieldMeta?: { label?: string } | null;
};
type TemplateRecipient = {
  id: number;
  role: string;
  email: string;
  name: string;
};
type Template = {
  id: number;
  title: string;
  recipients: TemplateRecipient[];
  fields: TemplateField[];
};

type UseTemplateRecipientResponse = {
  id: number;
  role: string;
  email: string;
  name: string;
  token: string;
};
type UseTemplateResponse = {
  id: number;
  envelopeId: string;
  status: string;
  title: string;
  recipients: UseTemplateRecipientResponse[];
};

// Mapping: snake_case id (matches FIELD_LAYOUT in setup-template-fields.ts) → human label.
// Same source of truth used at template-build time. Update both if a field is renamed.
//
// NB: EMAIL fields are NOT in this map. Documenso's v2 prefillFields schema has no "email"
// variant (only text/number/radio/checkbox/dropdown/date), and the server rejects a `text`
// prefill on an EMAIL field with "Field type mismatch". The recipient email passed at the
// document-recipient level auto-populates any EMAIL field on the template, so this is fine.
const FIELD_LABELS: Record<string, string> = {
  agent_name: 'Agent name',
  agent_license_number: 'Agent CA DRE #',
  consumer_name: 'Consumer name',
  consumer_phone: 'Consumer phone',
  property_type: 'Property type',
  search_area: 'Search area (city/zip)',
  term_days: 'Term (days)',
  commission_percent: 'Commission %',
  // signing_date / consumer_signature / consumer_email are filled at sign time
  // (or auto-populated from the recipient), not via prefillFields.
};

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function api<T>(
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit & { method?: string },
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText} on ${init.method ?? 'GET'} ${path}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body as T;
}

// Build a {prefillKey -> field meta} lookup for the v2 prefillFields payload.
// v2's prefillFields is a discriminated union on `type` (lowercased), and `value` is always string.
type PrefillField =
  | { id: number; type: 'text'; value: string }
  | { id: number; type: 'number'; value: string }
  | { id: number; type: 'dropdown'; value: string };

function buildPrefill(template: Template, data: Record<string, string | number>): PrefillField[] {
  const labelToField = new Map<string, TemplateField>();
  for (const f of template.fields) {
    const label = f.fieldMeta?.label;
    if (label) {
      labelToField.set(label, f);
    }
  }

  const out: PrefillField[] = [];
  for (const [snake, label] of Object.entries(FIELD_LABELS)) {
    const value = data[snake];
    if (value === undefined || value === '') {
      continue;
    }
    const f = labelToField.get(label);
    if (!f) {
      console.error(`! template has no field with label "${label}" (snake=${snake}); skipping`);
      continue;
    }
    const v = String(value);
    switch (f.type) {
      case 'TEXT':
        out.push({ id: f.id, type: 'text', value: v });
        break;
      case 'NUMBER':
        out.push({ id: f.id, type: 'number', value: v });
        break;
      case 'DROPDOWN':
        out.push({ id: f.id, type: 'dropdown', value: v });
        break;
      default:
        console.error(`! field "${label}" has unexpected type ${f.type}, skipping prefill`);
    }
  }
  return out;
}

async function main() {
  const baseUrl = process.env.REEVE_SIGN_BASE_URL ?? 'https://sign.meetreeve.com';
  const token = need('REEVE_SIGN_API_TOKEN');
  const templateId = Number(need('TEMPLATE_ID'));
  const distribute = process.env.DISTRIBUTE === '1';

  const data: Record<string, string | number> = {
    agent_name: process.env.AGENT_NAME ?? 'Alex Agent (Smoke)',
    agent_license_number: process.env.AGENT_LICENSE ?? 'DRE #01234567',
    consumer_name: process.env.CONSUMER_NAME ?? 'Jane Buyer (Smoke)',
    consumer_email: process.env.CONSUMER_EMAIL ?? 'matt+smoke-consumer@mindfortress.com',
    consumer_phone: process.env.CONSUMER_PHONE ?? '+14155550100',
    property_type: process.env.PROPERTY_TYPE ?? 'SFH',
    search_area: process.env.SEARCH_AREA ?? '94110 / Mission, SF',
    term_days: Number(process.env.TERM_DAYS ?? 90),
    commission_percent: Number(process.env.COMMISSION_PCT ?? 2.5),
  };

  console.log(`→ GET /api/v2/template/${templateId}`);
  const tpl = await api<Template>(baseUrl, token, `/api/v2/template/${templateId}`, { method: 'GET' });
  console.log(`  title: ${tpl.title}`);
  console.log(`  fields: ${tpl.fields.length}`);
  console.log(`  recipients: ${tpl.recipients.length}`);

  const signerSlot = tpl.recipients.find((r) => r.role === 'SIGNER') ?? tpl.recipients[0];
  if (!signerSlot) {
    console.error('Template has no recipients — cannot create envelope.');
    process.exit(1);
  }

  const prefillFields = buildPrefill(tpl, data);
  console.log(`  prefill: ${prefillFields.length} fields`);

  const body = {
    templateId,
    distributeDocument: distribute,
    recipients: [
      {
        id: signerSlot.id,
        email: String(data.consumer_email),
        name: String(data.consumer_name),
      },
    ],
    prefillFields,
  };

  console.log(`→ POST /api/v2/template/use   (distributeDocument=${distribute})`);
  const env = await api<UseTemplateResponse>(baseUrl, token, `/api/v2/template/use`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  console.log(`✓ Envelope created`);
  console.log(`  documentId: ${env.id}`);
  console.log(`  envelopeId: ${env.envelopeId}`);
  console.log(`  status: ${env.status}`);
  console.log(`  title: ${env.title}`);
  console.log(`  recipients:`);
  for (const r of env.recipients) {
    const signUrl = `${baseUrl}/sign/${r.token}`;
    console.log(`    [${r.role}] ${r.name} <${r.email}>`);
    console.log(`      token: ${r.token}`);
    console.log(`      signing URL: ${signUrl}`);
  }
  console.log('');
  console.log(`Inspect: ${baseUrl}/documents/${env.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
