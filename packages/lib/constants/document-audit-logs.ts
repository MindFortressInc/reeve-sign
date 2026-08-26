import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

import type { TDocumentAuditLogType } from '../types/document-audit-logs';
import { DOCUMENT_AUDIT_LOG_TYPE, DOCUMENT_EMAIL_TYPE } from '../types/document-audit-logs';

export const DOCUMENT_AUDIT_LOG_EMAIL_FORMAT = {
  [DOCUMENT_EMAIL_TYPE.SIGNING_REQUEST]: {
    description: 'Signing request',
  },
  [DOCUMENT_EMAIL_TYPE.VIEW_REQUEST]: {
    description: 'Viewing request',
  },
  [DOCUMENT_EMAIL_TYPE.APPROVE_REQUEST]: {
    description: 'Approval request',
  },
  [DOCUMENT_EMAIL_TYPE.ASSISTING_REQUEST]: {
    description: 'Assisting request',
  },
  [DOCUMENT_EMAIL_TYPE.CC]: {
    description: 'CC',
  },
  [DOCUMENT_EMAIL_TYPE.DOCUMENT_COMPLETED]: {
    description: 'Document completed',
  },
  [DOCUMENT_EMAIL_TYPE.REMINDER]: {
    description: 'Signing Reminder',
  },
} satisfies Record<keyof typeof DOCUMENT_EMAIL_TYPE, unknown>;

/**
 * Wording for the sender's OTP identity verification (DEV-8741), shared by the
 * two surfaces that display it: the signing-certificate footer
 * (server-only/pdf/render-certificate.ts) and the audit-log activity message
 * (utils/document-audit-logs.ts), which is printed on the Audit Log PDF.
 *
 * It lives here, as one descriptor, so the two can't drift apart: this is
 * copy on a legal document, `senderVerification` is client-supplied metadata
 * that any authenticated API caller can assert with no server-side proof the
 * OTP happened (DEV-8975), and the two surfaces can be attached to a sealed
 * document independently of each other (`includeSigningCertificate` and
 * `includeAuditLog` are separate settings). Sharing one descriptor also means
 * one msgid, so a translator sees this string once.
 *
 * DEV-9003. When DEV-8975 lands and the proof is genuinely server-held, this
 * is the single place to return to assertive "verified" wording.
 *
 * Deliberately a function rather than a `const`: `msg` is a compile-time Lingui
 * macro, and this module is reachable from `packages/prisma/seed-database.ts`
 * (seed/documents.ts -> server-only/envelope/create-envelope ->
 * utils/document-audit-logs -> here). The seed runs under `tsx`, which applies
 * no macro transform, so evaluating `msg()` at module scope throws
 * `TypeError: (0 , import_macro.msg) is not a function` at *import* time and
 * fails `prisma:seed` -- which the E2E job runs before a single test. Keeping
 * the call inside a function makes importing this module side-effect-free; only
 * the macro-compiled callers ever invoke it. Do not re-inline it to a `const`.
 *
 * The message and (absent) context are unchanged, so the generated msgid hash
 * is identical and the translations already shipped for this wording still
 * resolve -- extraction is static and finds the macro call inside the function.
 */
export const getSenderAttestedContactVerificationMessage = () =>
  msg({
    message: `Sender-attested contact verification (not independently verified)`,
    comment:
      'Shown in two places: as the signing-certificate footer label, followed by ": <contact> — <method> OTP, <timestamp>"; and on its own as an audit-log activity row. Must read correctly both as a label and as a standalone sentence.',
  });

/**
 * The human-facing heading for one audit-log row, per `DOCUMENT_AUDIT_LOG_TYPE`.
 *
 * DEV-9179. Both surfaces that show an audit-log row used to print
 * `auditLog.type.replace(/_/g, ' ')` -- the raw SCREAMING_SNAKE enum, in English
 * only, in every locale: the Audit Log PDF (server-only/pdf/render-audit-logs.ts)
 * and the internal audit table (apps/remix .../internal-audit-log-table.tsx,
 * which the Playwright HTML->PDF audit-log route also renders). Both now read
 * this map, so the same event cannot be headed differently on the two surfaces.
 *
 * The wording deliberately mirrors the noun-phrase already used by
 * `formatDocumentAuditLogAction`'s `anonymous` description (utils/document-audit-logs.ts),
 * which prints directly beneath this heading -- one vocabulary per event.
 * `DOCUMENT_SENDER_IDENTITY_VERIFIED` is the exception, and the reason this
 * ticket exists: its enum name reads "VERIFIED" while the sentence under it
 * (DEV-9003) says the verification is sender-attested and NOT independently
 * verified. The heading must not re-assert what the sentence retracts, so it is
 * "Sender contact attested".
 *
 * The builder's `Record<TDocumentAuditLogType, MessageDescriptor>` return type
 * makes the map exhaustive at compile time: adding a member to
 * `ZDocumentAuditLogTypeSchema` without a label here fails `tsc` rather than
 * silently printing snake_case onto a legal document.
 *
 * Deliberately a function rather than a `const`, for exactly the reason spelled
 * out on `getSenderAttestedContactVerificationMessage` above: `msg` is a
 * compile-time Lingui macro and this module is imported by
 * utils/document-audit-logs.ts, which `packages/prisma/seed-database.ts` reaches
 * under `tsx` (no macro transform). Evaluating `msg()` at module scope there
 * throws at *import* time and breaks `prisma:seed`, which the E2E job runs
 * before a single test. Do not re-inline it to a `const`.
 */
const buildDocumentAuditLogTypeLabels = (): Record<TDocumentAuditLogType, MessageDescriptor> => ({
  [DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT]: msg({
    message: `Email sent`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.FIELD_CREATED]: msg({
    message: `Field created`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.FIELD_DELETED]: msg({
    message: `Field deleted`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.FIELD_UPDATED]: msg({
    message: `Field updated`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_CREATED]: msg({
    message: `Recipient created`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_DELETED]: msg({
    message: `Recipient deleted`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.RECIPIENT_UPDATED]: msg({
    message: `Recipient updated`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.ENVELOPE_ITEM_CREATED]: msg({
    message: `Envelope item created`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.ENVELOPE_ITEM_DELETED]: msg({
    message: `Envelope item deleted`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.ENVELOPE_ITEM_UPDATED]: msg({
    message: `Envelope item updated`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.ENVELOPE_ITEM_PDF_REPLACED]: msg({
    message: `Envelope item PDF replaced`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_COMPLETED]: msg({
    message: `Document completed`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_CREATED]: msg({
    message: `Document created`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_DELETED]: msg({
    message: `Document deleted`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELDS_AUTO_INSERTED]: msg({
    message: `Fields auto inserted`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED]: msg({
    message: `Field signed`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_UNINSERTED]: msg({
    message: `Field unsigned`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_PREFILLED]: msg({
    message: `Field prefilled`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_VISIBILITY_UPDATED]: msg({
    message: `Document visibility updated`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_GLOBAL_AUTH_ACCESS_UPDATED]: msg({
    message: `Document access auth updated`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_GLOBAL_AUTH_ACTION_UPDATED]: msg({
    message: `Document signing auth updated`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_META_UPDATED]: msg({
    message: `Document updated`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_OPENED]: msg({
    message: `Document opened`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_VIEWED]: msg({
    message: `Document viewed`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_REJECTED]: msg({
    message: `Recipient rejected`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_COMPLETED]: msg({
    message: `Recipient completed`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_RECIPIENT_EXPIRED]: msg({
    message: `Signing window expired`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENT]: msg({
    message: `Document sent`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_TITLE_UPDATED]: msg({
    message: `Document title updated`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_EXTERNAL_ID_UPDATED]: msg({
    message: `Document external ID updated`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_MOVED_TO_TEAM]: msg({
    message: `Document moved to team`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_DELEGATED_OWNER_CREATED]: msg({
    message: `Document ownership delegated`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_REQUESTED]: msg({
    message: `2FA token requested`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_VALIDATED]: msg({
    message: `2FA token validated`,
    context: `Audit log event type`,
  }),
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_ACCESS_AUTH_2FA_FAILED]: msg({
    message: `2FA token validation failed`,
    context: `Audit log event type`,
  }),
  // Not "Sender identity verified": see the docstring above and DEV-9003 -- the
  // heading must not assert a verification the description underneath retracts.
  [DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENDER_IDENTITY_VERIFIED]: msg({
    message: `Sender contact attested`,
    context: `Audit log event type`,
  }),
});

let documentAuditLogTypeLabels: Record<TDocumentAuditLogType, MessageDescriptor> | undefined;

/**
 * Resolve the translated heading for an audit-log row's type.
 *
 * Pass the result to `i18n._()` at the render site. Built once and memoised:
 * the Audit Log PDF renders one row per event and there is no reason to rebuild
 * ~36 descriptors per row.
 */
export const getDocumentAuditLogTypeLabel = (type: TDocumentAuditLogType): MessageDescriptor => {
  documentAuditLogTypeLabels ??= buildDocumentAuditLogTypeLabels();

  // The map is exhaustive over the union (enforced by the builder's return
  // type), so this fallback is only reachable for a persisted row whose `type`
  // has since been dropped from the schema. It degrades to the old humanised
  // enum rather than printing `undefined` onto a legal document.
  return documentAuditLogTypeLabels[type] ?? { id: type, message: type.replace(/_/g, ' ') };
};
