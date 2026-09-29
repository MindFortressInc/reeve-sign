import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { REEVE_ADMIN_TOKEN_HEADER } from './reeve-admin-token';

const { ensureOrganisationMemberMock } = vi.hoisted(() => ({
  ensureOrganisationMemberMock: vi.fn(),
}));

vi.mock('./ensure-organisation-member', () => ({
  ensureOrganisationMember: ensureOrganisationMemberMock,
}));

const { handleEnsureOrganisationMemberRequest } = await import('./handle-ensure-organisation-member-request');

const ADMIN_TOKEN_ENV_KEY = 'REEVE_SIGN_ADMIN_TOKEN';
const VALID_TOKEN = 'super-secret-service-token';
const EXTERNAL_REFERENCE = 'org-mindfortress';
const BODY = { email: 'matt@mindfortress.com', name: 'Matt Rhodes' };

const makeRequest = (options: { headers?: Record<string, string>; body?: unknown } = {}) =>
  new Request(`http://localhost/api/reeve-admin/organisations/${EXTERNAL_REFERENCE}/members`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

describe('handleEnsureOrganisationMemberRequest', () => {
  const originalValue = process.env[ADMIN_TOKEN_ENV_KEY];

  beforeEach(() => {
    delete process.env[ADMIN_TOKEN_ENV_KEY];
    ensureOrganisationMemberMock.mockReset();
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ADMIN_TOKEN_ENV_KEY];
    } else {
      process.env[ADMIN_TOKEN_ENV_KEY] = originalValue;
    }
  });

  it('fails closed: 404 when REEVE_SIGN_ADMIN_TOKEN is unset, even with a token header', async () => {
    const response = await handleEnsureOrganisationMemberRequest(
      makeRequest({ headers: { [REEVE_ADMIN_TOKEN_HEADER]: 'whatever' }, body: BODY }),
      EXTERNAL_REFERENCE,
    );

    expect(response.status).toBe(404);
    expect(ensureOrganisationMemberMock).not.toHaveBeenCalled();
  });

  it('401 on a missing or wrong admin token', async () => {
    process.env[ADMIN_TOKEN_ENV_KEY] = VALID_TOKEN;

    for (const headers of [{}, { [REEVE_ADMIN_TOKEN_HEADER]: 'not-the-right-token' }]) {
      const response = await handleEnsureOrganisationMemberRequest(
        makeRequest({ headers, body: BODY }),
        EXTERNAL_REFERENCE,
      );

      expect(response.status).toBe(401);
    }

    expect(ensureOrganisationMemberMock).not.toHaveBeenCalled();
  });

  it('400 on an invalid body', async () => {
    process.env[ADMIN_TOKEN_ENV_KEY] = VALID_TOKEN;

    for (const body of [
      { name: 'Matt' },
      { email: 'not-an-email', name: 'Matt' },
      { email: 'matt@mindfortress.com' },
    ]) {
      const response = await handleEnsureOrganisationMemberRequest(
        makeRequest({ headers: { [REEVE_ADMIN_TOKEN_HEADER]: VALID_TOKEN }, body }),
        EXTERNAL_REFERENCE,
      );

      expect(response.status).toBe(400);
    }

    expect(ensureOrganisationMemberMock).not.toHaveBeenCalled();
  });

  it('404 when the organisation is unknown', async () => {
    process.env[ADMIN_TOKEN_ENV_KEY] = VALID_TOKEN;
    ensureOrganisationMemberMock.mockRejectedValue(
      new AppError(AppErrorCode.NOT_FOUND, { message: 'Organisation not found' }),
    );

    const response = await handleEnsureOrganisationMemberRequest(
      makeRequest({ headers: { [REEVE_ADMIN_TOKEN_HEADER]: VALID_TOKEN }, body: BODY }),
      'org-unknown',
    );

    expect(response.status).toBe(404);
  });

  it('200 {user_id, created} on success', async () => {
    process.env[ADMIN_TOKEN_ENV_KEY] = VALID_TOKEN;
    ensureOrganisationMemberMock.mockResolvedValue({ userId: 77, created: true });

    const response = await handleEnsureOrganisationMemberRequest(
      makeRequest({ headers: { [REEVE_ADMIN_TOKEN_HEADER]: VALID_TOKEN }, body: BODY }),
      EXTERNAL_REFERENCE,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user_id: 77, created: true });
    expect(ensureOrganisationMemberMock).toHaveBeenCalledWith({
      externalReference: EXTERNAL_REFERENCE,
      email: 'matt@mindfortress.com',
      name: 'Matt Rhodes',
    });
  });

  it('200 with created=false for an existing user', async () => {
    process.env[ADMIN_TOKEN_ENV_KEY] = VALID_TOKEN;
    ensureOrganisationMemberMock.mockResolvedValue({ userId: 3, created: false });

    const response = await handleEnsureOrganisationMemberRequest(
      makeRequest({ headers: { [REEVE_ADMIN_TOKEN_HEADER]: VALID_TOKEN }, body: BODY }),
      EXTERNAL_REFERENCE,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user_id: 3, created: false });
  });
  it('400 when the user is disabled', async () => {
    process.env[ADMIN_TOKEN_ENV_KEY] = VALID_TOKEN;
    ensureOrganisationMemberMock.mockRejectedValue(
      new AppError(AppErrorCode.INVALID_REQUEST, { message: 'User is disabled' }),
    );

    const response = await handleEnsureOrganisationMemberRequest(
      makeRequest({ headers: { [REEVE_ADMIN_TOKEN_HEADER]: VALID_TOKEN }, body: BODY }),
      EXTERNAL_REFERENCE,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'User is disabled' });
  });
});
