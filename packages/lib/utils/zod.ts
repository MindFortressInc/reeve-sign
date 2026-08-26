import { z } from 'zod';

/**
 * RFC 5322 compliant email regex.
 *
 * This is more permissive than Zod's built-in `.email()` validator which rejects
 * valid international characters (e.g. "Søren@gmail.com").
 *
 * Compiled once at module level to avoid re-compilation on every validation call.
 */
const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~\u{0080}-\u{FFFF}-]+@[a-zA-Z0-9\u{0080}-\u{FFFF}](?:[a-zA-Z0-9\u{0080}-\u{FFFF}-]{0,61}[a-zA-Z0-9\u{0080}-\u{FFFF}])?(?:\.[a-zA-Z0-9\u{0080}-\u{FFFF}](?:[a-zA-Z0-9\u{0080}-\u{FFFF}-]{0,61}[a-zA-Z0-9\u{0080}-\u{FFFF}])?)*$/u;

const DEFAULT_EMAIL_MESSAGE = 'Invalid email address';

/**
 * Creates a Zod email schema using an RFC 5322 compliant regex.
 *
 * Supports international characters in the local part and domain
 * (e.g. "Søren@gmail.com", "user@dömain.com").
 *
 * Returns a standard `ZodString` so all string methods are chainable:
 * `.min()`, `.max()`, `.trim()`, `.toLowerCase()`, `.optional()`, `.nullish()`, etc.
 *
 * @example
 * ```ts
 * zEmail()
 * zEmail().min(1).max(254)
 * zEmail().trim().toLowerCase()
 * zEmail('Email is invalid')
 * zEmail({ message: 'Email is invalid' })
 * ```
 */
export const zEmail = (options?: string | { message?: string }) => {
  const message = typeof options === 'string' ? options : (options?.message ?? DEFAULT_EMAIL_MESSAGE);

  return z.string().regex(EMAIL_REGEX, { message });
};

/**
 * E.164 phone format: a leading `+`, no leading zero, 2-15 digits total.
 */
export const E164_PHONE_REGEX = /^\+[1-9]\d{1,14}$/;

/**
 * True iff `contact` is a well-formed value for the claimed `method`: a valid
 * email for `'email'`, an E.164 phone number for `'sms'`.
 *
 * DEV-8741: shared between the v1 API's sender-verification input
 * (`packages/api/v1/schema.ts`) and the `DOCUMENT_SENDER_IDENTITY_VERIFIED`
 * audit-log event (`packages/lib/types/document-audit-logs.ts`) -- one
 * validated rule, not two independently-drifting copies. Both surfaces print
 * `contact` verbatim as a sender attestation -- Reeve does not independently
 * verify it (DEV-9177) -- so it must still look like the claimed channel
 * rather than accepting any non-empty string.
 */
export const contactMatchesMethod = (contact: string, method: 'email' | 'sms'): boolean =>
  method === 'email' ? zEmail().safeParse(contact).success : E164_PHONE_REGEX.test(contact);
