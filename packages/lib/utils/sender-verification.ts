import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { DateTime } from 'luxon';

import { APP_I18N_OPTIONS } from '../constants/i18n';

/**
 * The sender's OTP identity-verification metadata (DEV-8741), structurally
 * shared by the two things that print it: the `senderVerification` block on the
 * signing certificate (`CertificateSenderVerification`, server-only/pdf/render-certificate.ts)
 * and the `DOCUMENT_SENDER_IDENTITY_VERIFIED` audit-log event's `data`
 * (types/document-audit-logs.ts).
 */
export type SenderVerificationValue = {
  contact: string;
  method: 'email' | 'sms';
  verifiedAt: string;
};

/**
 * DEV-8741: format the sender identity-verification line shown on the
 * certificate footer. Takes `i18n` explicitly (rather than importing the
 * module singleton) so it stays a pure, directly unit-testable function --
 * same reasoning as every other label on this certificate, which all go
 * through `i18n._(msg\`...\`)` at their call sites.
 *
 * DEV-9178: lifted out of server-only/pdf/render-certificate.ts (which
 * re-exports it) into utils/ so utils/document-audit-logs.ts can compose the
 * same value onto the audit-log row. That module is imported by remix client
 * components and, under `tsx`, by packages/prisma/seed-database.ts -- it
 * cannot reach into a module that imports Konva/skia-canvas. This file's only
 * runtime dependency is luxon, which the remix client already bundles.
 *
 * `msg` is a compile-time Lingui macro, so it is only ever called from inside
 * this function -- importing the module stays side-effect-free, for the same
 * reason spelled out on `getSenderAttestedContactVerificationMessage`
 * (constants/document-audit-logs.ts).
 */
export const formatSenderVerificationValue = (senderVerification: SenderVerificationValue, i18n: I18n): string => {
  const methodLabel = senderVerification.method === 'sms' ? i18n._(msg`SMS`) : i18n._(msg`Email`);

  // `setZone: true` keeps the offset the sender's timestamp was recorded
  // with, so the certificate shows the verification in that zone rather than
  // silently rebasing it onto the renderer's local zone.
  const verifiedAt = DateTime.fromISO(senderVerification.verifiedAt, { setZone: true }).setLocale(
    APP_I18N_OPTIONS.defaultLocale,
  );

  const formattedTimestamp = verifiedAt.isValid
    ? verifiedAt.toFormat('yyyy-MM-dd hh:mm:ss a (ZZZZ)')
    : senderVerification.verifiedAt;

  return `${senderVerification.contact} — ${methodLabel} ${i18n._(msg`OTP`)}, ${formattedTimestamp}`;
};
