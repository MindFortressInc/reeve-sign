import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentAuth } from '../../types/document-auth';

const {
  userFindFirstMock,
  extractDocumentAuthMethodsMock,
  verifyPasswordMock,
  verifyTwoFactorAuthenticationTokenMock,
  validateTwoFactorTokenFromEmailMock,
} = vi.hoisted(() => ({
  userFindFirstMock: vi.fn(),
  extractDocumentAuthMethodsMock: vi.fn(),
  verifyPasswordMock: vi.fn(),
  verifyTwoFactorAuthenticationTokenMock: vi.fn(),
  validateTwoFactorTokenFromEmailMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: { findFirst: userFindFirstMock },
    passkey: { findFirst: vi.fn() },
    verificationToken: { delete: vi.fn() },
  },
}));

vi.mock('../../utils/document-auth', () => ({
  extractDocumentAuthMethods: extractDocumentAuthMethodsMock,
}));

vi.mock('../2fa/verify-password', () => ({
  verifyPassword: verifyPasswordMock,
}));

vi.mock('../2fa/verify-2fa-token', () => ({
  verifyTwoFactorAuthenticationToken: verifyTwoFactorAuthenticationTokenMock,
}));

vi.mock('../2fa/email/validate-2fa-token-from-email', () => ({
  validateTwoFactorTokenFromEmail: validateTwoFactorTokenFromEmailMock,
}));

import { isRecipientAuthorized } from './is-recipient-authorized';

const HOST_USER_ID = 1;
const RECIPIENT_USER_ID = 2;

const recipient = {
  email: 'recipient@example.com',
  authOptions: { accessAuth: [], actionAuth: [] },
  envelopeId: 'envelope-1',
};

describe('isRecipientAuthorized ACTION auth — recipient-account binding (DEV-654 handoff regression)', () => {
  beforeEach(() => {
    userFindFirstMock.mockReset();
    extractDocumentAuthMethodsMock.mockReset();
    verifyPasswordMock.mockReset();
    verifyTwoFactorAuthenticationTokenMock.mockReset();
    validateTwoFactorTokenFromEmailMock.mockReset();
  });

  it("PASSWORD: rejects a DIFFERENT logged-in account's correct password (host credentials must never satisfy another recipient's ACTION auth)", async () => {
    extractDocumentAuthMethodsMock.mockReturnValue({
      derivedRecipientAccessAuth: [],
      derivedRecipientActionAuth: [DocumentAuth.PASSWORD],
    });
    // The RECIPIENT's own account is a different user than whoever is logged in (the host).
    userFindFirstMock.mockResolvedValue({ id: RECIPIENT_USER_ID });
    // Host's own password is genuinely correct for the host's own account.
    verifyPasswordMock.mockResolvedValue(true);

    const result = await isRecipientAuthorized({
      type: 'ACTION',
      documentAuthOptions: null,
      recipient,
      userId: HOST_USER_ID,
      authOptions: { type: DocumentAuth.PASSWORD, password: 'hosts-own-correct-password' },
    });

    expect(result).toBe(false);
    expect(verifyPasswordMock).not.toHaveBeenCalled();
  });

  it("PASSWORD: accepts the recipient's own account with their own correct password (regression: existing behavior preserved)", async () => {
    extractDocumentAuthMethodsMock.mockReturnValue({
      derivedRecipientAccessAuth: [],
      derivedRecipientActionAuth: [DocumentAuth.PASSWORD],
    });
    userFindFirstMock.mockResolvedValue({ id: RECIPIENT_USER_ID });
    verifyPasswordMock.mockResolvedValue(true);

    const result = await isRecipientAuthorized({
      type: 'ACTION',
      documentAuthOptions: null,
      recipient,
      userId: RECIPIENT_USER_ID,
      authOptions: { type: DocumentAuth.PASSWORD, password: 'recipients-own-correct-password' },
    });

    expect(result).toBe(true);
    expect(verifyPasswordMock).toHaveBeenCalledWith({
      userId: RECIPIENT_USER_ID,
      password: 'recipients-own-correct-password',
    });
  });

  it("TWO_FACTOR_AUTH (authenticator/TOTP): rejects a DIFFERENT logged-in account's valid TOTP", async () => {
    extractDocumentAuthMethodsMock.mockReturnValue({
      derivedRecipientAccessAuth: [],
      derivedRecipientActionAuth: [DocumentAuth.TWO_FACTOR_AUTH],
    });
    userFindFirstMock.mockResolvedValue({ id: RECIPIENT_USER_ID });
    verifyTwoFactorAuthenticationTokenMock.mockResolvedValue(true);

    const result = await isRecipientAuthorized({
      type: 'ACTION',
      documentAuthOptions: null,
      recipient,
      userId: HOST_USER_ID,
      authOptions: { type: DocumentAuth.TWO_FACTOR_AUTH, token: '123456', method: 'authenticator' },
    });

    expect(result).toBe(false);
    expect(verifyTwoFactorAuthenticationTokenMock).not.toHaveBeenCalled();
  });

  it('TWO_FACTOR_AUTH email method: unaffected by the account-binding fix (already recipient-email-bound)', async () => {
    extractDocumentAuthMethodsMock.mockReturnValue({
      derivedRecipientAccessAuth: [DocumentAuth.TWO_FACTOR_AUTH],
      derivedRecipientActionAuth: [],
    });
    validateTwoFactorTokenFromEmailMock.mockResolvedValue(true);

    const result = await isRecipientAuthorized({
      type: 'ACCESS_2FA',
      documentAuthOptions: null,
      recipient,
      userId: HOST_USER_ID,
      authOptions: { type: DocumentAuth.TWO_FACTOR_AUTH, token: '123456', method: 'email' },
    });

    expect(result).toBe(true);
    expect(validateTwoFactorTokenFromEmailMock).toHaveBeenCalledWith({
      envelopeId: recipient.envelopeId,
      email: recipient.email,
      code: '123456',
      window: 10,
    });
    expect(userFindFirstMock).not.toHaveBeenCalled();
  });

  it("ACCOUNT: unaffected by the fix — still requires the recipient's own account (regression)", async () => {
    extractDocumentAuthMethodsMock.mockReturnValue({
      derivedRecipientAccessAuth: [],
      derivedRecipientActionAuth: [DocumentAuth.ACCOUNT],
    });
    userFindFirstMock.mockResolvedValue({ id: RECIPIENT_USER_ID });

    const asHost = await isRecipientAuthorized({
      type: 'ACTION',
      documentAuthOptions: null,
      recipient,
      userId: HOST_USER_ID,
      authOptions: { type: DocumentAuth.ACCOUNT },
    });

    expect(asHost).toBe(false);

    const asRecipient = await isRecipientAuthorized({
      type: 'ACTION',
      documentAuthOptions: null,
      recipient,
      userId: RECIPIENT_USER_ID,
      authOptions: { type: DocumentAuth.ACCOUNT },
    });

    expect(asRecipient).toBe(true);
  });

  it('PASSWORD: returns false (not a throw) when no user exists for the recipient email at all', async () => {
    extractDocumentAuthMethodsMock.mockReturnValue({
      derivedRecipientAccessAuth: [],
      derivedRecipientActionAuth: [DocumentAuth.PASSWORD],
    });
    userFindFirstMock.mockResolvedValue(null);

    const result = await isRecipientAuthorized({
      type: 'ACTION',
      documentAuthOptions: null,
      recipient,
      userId: HOST_USER_ID,
      authOptions: { type: DocumentAuth.PASSWORD, password: 'anything' },
    });

    expect(result).toBe(false);
    expect(verifyPasswordMock).not.toHaveBeenCalled();
  });
});
