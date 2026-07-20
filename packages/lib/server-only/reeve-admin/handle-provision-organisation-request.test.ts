import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REEVE_ADMIN_TOKEN_HEADER } from './reeve-admin-token';

const { provisionOrganisationMock } = vi.hoisted(() => ({
  provisionOrganisationMock: vi.fn(),
}));

vi.mock('./provision-organisation', () => ({
  provisionOrganisation: provisionOrganisationMock,
}));

const { handleProvisionOrganisationRequest } = await import('./handle-provision-organisation-request');

const ADMIN_TOKEN_ENV_KEY = 'REEVE_SIGN_ADMIN_TOKEN';
const VALID_TOKEN = 'super-secret-service-token';

const makeRequest = (options: { headers?: Record<string, string>; body?: unknown } = {}) =>
  new Request('http://localhost/api/reeve-admin/organisations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

describe('handleProvisionOrganisationRequest', () => {
  const originalValue = process.env[ADMIN_TOKEN_ENV_KEY];

  beforeEach(() => {
    delete process.env[ADMIN_TOKEN_ENV_KEY];
    provisionOrganisationMock.mockReset();
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ADMIN_TOKEN_ENV_KEY];
    } else {
      process.env[ADMIN_TOKEN_ENV_KEY] = originalValue;
    }
  });

  it('fails closed: returns a disabled response when REEVE_SIGN_ADMIN_TOKEN is unset, even with a token header', async () => {
    const request = makeRequest({
      headers: { [REEVE_ADMIN_TOKEN_HEADER]: 'whatever' },
      body: { name: 'Acme', external_reference: 'host_app:acme' },
    });

    const response = await handleProvisionOrganisationRequest(request);

    expect([404, 503]).toContain(response.status);
    expect(provisionOrganisationMock).not.toHaveBeenCalled();
  });

  it('rejects a missing token header when configured', async () => {
    process.env[ADMIN_TOKEN_ENV_KEY] = VALID_TOKEN;

    const request = makeRequest({ body: { name: 'Acme', external_reference: 'host_app:acme' } });

    const response = await handleProvisionOrganisationRequest(request);

    expect([401, 403]).toContain(response.status);
    expect(provisionOrganisationMock).not.toHaveBeenCalled();
  });

  it('rejects a wrong token header when configured', async () => {
    process.env[ADMIN_TOKEN_ENV_KEY] = VALID_TOKEN;

    const request = makeRequest({
      headers: { [REEVE_ADMIN_TOKEN_HEADER]: 'not-the-right-token' },
      body: { name: 'Acme', external_reference: 'host_app:acme' },
    });

    const response = await handleProvisionOrganisationRequest(request);

    expect([401, 403]).toContain(response.status);
    expect(provisionOrganisationMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid request body with 400', async () => {
    process.env[ADMIN_TOKEN_ENV_KEY] = VALID_TOKEN;

    const request = makeRequest({
      headers: { [REEVE_ADMIN_TOKEN_HEADER]: VALID_TOKEN },
      body: { name: 'Acme' }, // missing external_reference
    });

    const response = await handleProvisionOrganisationRequest(request);

    expect(response.status).toBe(400);
    expect(provisionOrganisationMock).not.toHaveBeenCalled();
  });

  it('returns 201 with the minted token on creation', async () => {
    process.env[ADMIN_TOKEN_ENV_KEY] = VALID_TOKEN;
    provisionOrganisationMock.mockResolvedValue({
      organisationId: 'org_new',
      apiToken: 'api_minted_token',
      created: true,
    });

    const request = makeRequest({
      headers: { [REEVE_ADMIN_TOKEN_HEADER]: VALID_TOKEN },
      body: { name: 'Acme', external_reference: 'host_app:acme' },
    });

    const response = await handleProvisionOrganisationRequest(request);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ organisation_id: 'org_new', api_token: 'api_minted_token' });
    expect(provisionOrganisationMock).toHaveBeenCalledWith({
      name: 'Acme',
      externalReference: 'host_app:acme',
    });
  });

  it('returns 200 with a null token on an idempotent hit', async () => {
    process.env[ADMIN_TOKEN_ENV_KEY] = VALID_TOKEN;
    provisionOrganisationMock.mockResolvedValue({
      organisationId: 'org_existing',
      apiToken: null,
      created: false,
    });

    const request = makeRequest({
      headers: { [REEVE_ADMIN_TOKEN_HEADER]: VALID_TOKEN },
      body: { name: 'Acme', external_reference: 'host_app:acme' },
    });

    const response = await handleProvisionOrganisationRequest(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ organisation_id: 'org_existing', api_token: null });
  });
});
