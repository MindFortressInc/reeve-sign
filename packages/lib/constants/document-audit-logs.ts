import { msg } from '@lingui/core/macro';

import { DOCUMENT_EMAIL_TYPE } from '../types/document-audit-logs';

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
 */
export const SENDER_ATTESTED_CONTACT_VERIFICATION_MESSAGE = msg({
  message: `Sender-attested contact verification (not independently verified)`,
  comment:
    'Shown in two places: as the signing-certificate footer label, followed by ": <contact> — <method> OTP, <timestamp>"; and on its own as an audit-log activity row. Must read correctly both as a label and as a standalone sentence.',
});
