import { OrganisationType, WebhookTriggerEvents } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { INTERNAL_CLAIM_ID, internalClaims } from '../../types/subscription';
import { deriveOrganisationUrlFromExternalReference } from './derive-organisation-url';

const {
  findUniqueMock,
  findUniqueOrThrowMock,
  findFirstMock,
  findFirstOrThrowMock,
  apiTokenFindFirstMock,
  createOrganisationMock,
  createTeamMock,
  createApiTokenMock,
  getReeveAdminSystemUserMock,
  organisationUpdateMock,
  webhookFindFirstMock,
  webhookCreateMock,
  webhookUpdateMock,
  executeRawMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  findUniqueOrThrowMock: vi.fn(),
  findFirstMock: vi.fn(),
  findFirstOrThrowMock: vi.fn(),
  apiTokenFindFirstMock: vi.fn(),
  createOrganisationMock: vi.fn(),
  createTeamMock: vi.fn(),
  createApiTokenMock: vi.fn(),
  getReeveAdminSystemUserMock: vi.fn(),
  organisationUpdateMock: vi.fn(),
  webhookFindFirstMock: vi.fn(),
  webhookCreateMock: vi.fn(),
  webhookUpdateMock: vi.fn(),
  executeRawMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    organisation: {
      findUnique: findUniqueMock,
      findUniqueOrThrow: findUniqueOrThrowMock,
      update: organisationUpdateMock,
    },
    team: {
      findFirst: findFirstMock,
      findFirstOrThrow: findFirstOrThrowMock,
    },
    apiToken: {
      findFirst: apiTokenFindFirstMock,
    },
    webhook: {
      findFirst: webhookFindFirstMock,
      create: webhookCreateMock,
      update: webhookUpdateMock,
    },
    // The webhook ensure runs in a transaction under an advisory lock; the
    // tx client is the same mock surface.
    $transaction: async (fn: (tx: unknown) => unknown) =>
      await fn({
        $executeRaw: executeRawMock,
        webhook: { findFirst: webhookFindFirstMock, create: webhookCreateMock, update: webhookUpdateMock },
      }),
  },
}));

vi.mock('../organisation/create-organisation', () => ({
  createOrganisation: createOrganisationMock,
}));

vi.mock('../team/create-team', () => ({
  createTeam: createTeamMock,
}));

vi.mock('../public-api/create-api-token', () => ({
  createApiToken: createApiTokenMock,
}));

vi.mock('./get-reeve-admin-system-user', () => ({
  getReeveAdminSystemUser: getReeveAdminSystemUserMock,
}));

// Imported after the mocks above so the module under test picks them up.
const { provisionOrganisation } = await import('./provision-organisation');

const SYSTEM_USER = { id: 999, email: 'reeve-provisioner@meetreeve.com' };

// An already-provisioned org row as `findUnique` returns it (with its
// global settings included), already in the target ORGANISATION state.
const existingOrg = (id: string, url: string, overrides: Record<string, unknown> = {}) => ({
  id,
  url,
  ownerUserId: SYSTEM_USER.id,
  owner: { email: SYSTEM_USER.email },
  type: OrganisationType.ORGANISATION,
  organisationGlobalSettings: { includeSenderDetails: true },
  organisationClaim: { originalSubscriptionClaimId: 'platform' },
  ...overrides,
});

const REEVE_AGENTS_WEBHOOK_EVENTS = [
  WebhookTriggerEvents.DOCUMENT_SENT,
  WebhookTriggerEvents.DOCUMENT_OPENED,
  WebhookTriggerEvents.DOCUMENT_SIGNED,
  WebhookTriggerEvents.DOCUMENT_COMPLETED,
  WebhookTriggerEvents.DOCUMENT_REJECTED,
  WebhookTriggerEvents.DOCUMENT_CANCELLED,
];

const WEBHOOK = { url: 'https://agents.meetreeve.com/webhooks/documenso', secret: 'whsec_1' };

describe('provisionOrganisation', () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    findUniqueOrThrowMock.mockReset();
    findFirstMock.mockReset();
    findFirstOrThrowMock.mockReset();
    apiTokenFindFirstMock.mockReset();
    createOrganisationMock.mockReset();
    createTeamMock.mockReset();
    createApiTokenMock.mockReset();
    getReeveAdminSystemUserMock.mockReset();
    getReeveAdminSystemUserMock.mockResolvedValue(SYSTEM_USER);
    organisationUpdateMock.mockReset();
    webhookFindFirstMock.mockReset();
    webhookCreateMock.mockReset();
    webhookUpdateMock.mockReset();
    executeRawMock.mockReset();
    vi.stubEnv('REEVE_SIGN_SYSTEM_USER_EMAIL', SYSTEM_USER.email);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('idempotent hit: org + team + token all already exist -> returns the existing org, creates nothing', async () => {
    const url = deriveOrganisationUrlFromExternalReference('host_app:tenant-123');

    findUniqueMock.mockResolvedValue(existingOrg('org_existing', url));
    findFirstMock.mockResolvedValue({ id: 7, organisationId: 'org_existing' });
    apiTokenFindFirstMock.mockResolvedValue({ id: 1, teamId: 7 });

    const result = await provisionOrganisation({ name: 'Tenant 123', externalReference: 'host_app:tenant-123' });

    expect(result).toEqual({ organisationId: 'org_existing', apiToken: null, created: false });
    expect(createOrganisationMock).not.toHaveBeenCalled();
    expect(createTeamMock).not.toHaveBeenCalled();
    expect(createApiTokenMock).not.toHaveBeenCalled();
  });

  it('same external_reference twice: second call is idempotent (no duplicate org)', async () => {
    const externalReference = 'host_app:tenant-123';
    const url = deriveOrganisationUrlFromExternalReference(externalReference);

    // First call: nothing exists yet.
    findUniqueMock.mockResolvedValueOnce(null);
    createOrganisationMock.mockResolvedValueOnce({ id: 'org_new', url, ownerUserId: SYSTEM_USER.id });
    findFirstMock.mockResolvedValueOnce(null); // no team yet
    createTeamMock.mockResolvedValueOnce(undefined);
    findFirstOrThrowMock.mockResolvedValueOnce({ id: 7, organisationId: 'org_new' });
    createApiTokenMock.mockResolvedValueOnce({ id: 1, token: 'api_first_token' });

    const first = await provisionOrganisation({ name: 'Tenant 123', externalReference });

    expect(first).toEqual({ organisationId: 'org_new', apiToken: 'api_first_token', created: true });
    expect(createOrganisationMock).toHaveBeenCalledTimes(1);

    // Second call: the org (and its team, and its token) now exist
    // (persistent, DB-backed lookup by the deterministically-derived url —
    // not in-memory).
    findUniqueMock.mockResolvedValueOnce(existingOrg('org_new', url));
    findFirstMock.mockResolvedValueOnce({ id: 7, organisationId: 'org_new' });
    apiTokenFindFirstMock.mockResolvedValueOnce({ id: 1, teamId: 7 });

    const second = await provisionOrganisation({ name: 'Tenant 123', externalReference });

    expect(second).toEqual({ organisationId: 'org_new', apiToken: null, created: false });
    // Still only ever called once across both requests -> no duplicate org.
    expect(createOrganisationMock).toHaveBeenCalledTimes(1);
    expect(createTeamMock).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh organisation, team, and org-scoped api token when none exists', async () => {
    const externalReference = 'host_app:tenant-456';
    const url = deriveOrganisationUrlFromExternalReference(externalReference);

    findUniqueMock.mockResolvedValue(null);
    createOrganisationMock.mockResolvedValue({ id: 'org_456', url, ownerUserId: SYSTEM_USER.id });
    findFirstMock.mockResolvedValue(null);
    createTeamMock.mockResolvedValue(undefined);
    findFirstOrThrowMock.mockResolvedValue({ id: 42, organisationId: 'org_456' });
    createApiTokenMock.mockResolvedValue({ id: 2, token: 'api_scoped_token' });

    const result = await provisionOrganisation({ name: 'Tenant 456', externalReference });

    expect(result).toEqual({ organisationId: 'org_456', apiToken: 'api_scoped_token', created: true });

    // Billing-bypass: created via the reused createOrganisation lib directly
    // (never through the tRPC route's free-org-limit check), using the
    // PLATFORM internal claim, owned by the system user.
    expect(createOrganisationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: SYSTEM_USER.id,
        type: OrganisationType.ORGANISATION,
        claim: internalClaims[INTERNAL_CLAIM_ID.PLATFORM],
        url,
      }),
    );

    // Token-scoping: the minted token must be scoped to the team that
    // belongs to the org we just created, not some other team.
    expect(createApiTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: SYSTEM_USER.id,
        teamId: 42,
      }),
    );
    expect(findFirstOrThrowMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organisationId: 'org_456' }) }),
    );
  });

  it('billing-bypass: provisions organisation N+1 for the system user without any free-org limit check', async () => {
    findUniqueMock.mockResolvedValue(null);
    findFirstMock.mockResolvedValue(null);
    findFirstOrThrowMock.mockResolvedValue({ id: 1, organisationId: 'org_x' });
    createApiTokenMock.mockResolvedValue({ id: 1, token: 'api_token' });

    for (let i = 0; i < 5; i += 1) {
      createOrganisationMock.mockResolvedValueOnce({ id: `org_${i}`, url: `reeve-ext-${i}` });

      const result = await provisionOrganisation({
        name: `Tenant ${i}`,
        externalReference: `host_app:tenant-${i}`,
      });

      expect(result.created).toBe(true);
    }

    // Org #6 (index 5, i.e. N+1 relative to a hypothetical 1-free-org limit)
    // still provisions successfully.
    expect(createOrganisationMock).toHaveBeenCalledTimes(5);
  });

  it('handles a create race safely: ALREADY_EXISTS from createOrganisation resolves to the (already-complete) winner', async () => {
    const externalReference = 'host_app:tenant-race';
    const url = deriveOrganisationUrlFromExternalReference(externalReference);

    findUniqueMock.mockResolvedValueOnce(null);
    createOrganisationMock.mockRejectedValueOnce(
      new AppError(AppErrorCode.ALREADY_EXISTS, { message: 'Organisation URL already exists' }),
    );
    findUniqueOrThrowMock.mockResolvedValueOnce({ id: 'org_race_winner', url, owner: { email: SYSTEM_USER.email } });
    // The concurrent winner request finished its own team/token setup
    // before we observed ALREADY_EXISTS, so this is a true idempotent hit.
    findFirstMock.mockResolvedValueOnce({ id: 9, organisationId: 'org_race_winner' });
    apiTokenFindFirstMock.mockResolvedValueOnce({ id: 5, teamId: 9 });

    const result = await provisionOrganisation({ name: 'Tenant Race', externalReference });

    expect(result).toEqual({ organisationId: 'org_race_winner', apiToken: null, created: false });
    expect(createTeamMock).not.toHaveBeenCalled();
    expect(createApiTokenMock).not.toHaveBeenCalled();
  });

  it('self-heals a partial prior failure: org exists but its team/token step never completed', async () => {
    const externalReference = 'host_app:tenant-partial';
    const url = deriveOrganisationUrlFromExternalReference(externalReference);

    // The organisation row survives from a prior call whose createTeam or
    // createApiToken step failed (e.g. a transient DB error) after
    // createOrganisation had already committed.
    findUniqueMock.mockResolvedValue(existingOrg('org_partial', url));
    findFirstMock.mockResolvedValueOnce(null); // no team yet -> incomplete
    createTeamMock.mockResolvedValueOnce(undefined);
    findFirstOrThrowMock.mockResolvedValueOnce({ id: 11, organisationId: 'org_partial' });
    createApiTokenMock.mockResolvedValueOnce({ id: 3, token: 'api_healed_token' });

    const result = await provisionOrganisation({ name: 'Tenant Partial', externalReference });

    // A real, non-null token is delivered — the caller is not permanently
    // stranded just because the organisation row already existed.
    expect(result).toEqual({ organisationId: 'org_partial', apiToken: 'api_healed_token', created: true });
    expect(createOrganisationMock).not.toHaveBeenCalled();
    expect(createTeamMock).toHaveBeenCalledWith(expect.objectContaining({ organisationId: 'org_partial' }));
    expect(createApiTokenMock).toHaveBeenCalledWith(expect.objectContaining({ userId: SYSTEM_USER.id, teamId: 11 }));
  });

  it('self-heals a deeper partial failure: org + team exist but the token was never minted', async () => {
    const externalReference = 'host_app:tenant-partial-token';
    const url = deriveOrganisationUrlFromExternalReference(externalReference);

    // The team row survives from a prior call whose createApiToken step
    // failed/crashed after createTeam had already committed. Team-existence
    // alone must NOT be treated as "fully provisioned" — the token is the
    // deliverable the caller actually needs.
    findUniqueMock.mockResolvedValue(existingOrg('org_partial_token', url));
    findFirstMock.mockResolvedValue({ id: 21, organisationId: 'org_partial_token' });
    apiTokenFindFirstMock.mockResolvedValueOnce(null); // team exists, but no token yet
    createApiTokenMock.mockResolvedValueOnce({ id: 4, token: 'api_healed_token_2' });

    const result = await provisionOrganisation({ name: 'Tenant Partial Token', externalReference });

    expect(result).toEqual({ organisationId: 'org_partial_token', apiToken: 'api_healed_token_2', created: true });
    // The team already existed -> never re-created.
    expect(createOrganisationMock).not.toHaveBeenCalled();
    expect(createTeamMock).not.toHaveBeenCalled();
    // But the missing token IS minted, scoped to the existing team.
    expect(createApiTokenMock).toHaveBeenCalledWith(expect.objectContaining({ userId: SYSTEM_USER.id, teamId: 21 }));
  });

  it('fails loud when the system user cannot be resolved, without creating anything', async () => {
    findUniqueMock.mockResolvedValue(null);
    getReeveAdminSystemUserMock.mockRejectedValue(
      new AppError(AppErrorCode.NOT_SETUP, { message: 'REEVE_SIGN_SYSTEM_USER_EMAIL is not set.' }),
    );

    await expect(
      provisionOrganisation({ name: 'Tenant Fail', externalReference: 'host_app:tenant-fail' }),
    ).rejects.toThrow(AppError);

    expect(createOrganisationMock).not.toHaveBeenCalled();
  });
  it('creates new orgs as ORGANISATION type (sender details render as "<user> on behalf of <team>")', async () => {
    findUniqueMock.mockResolvedValue(null);
    createOrganisationMock.mockResolvedValue({ id: 'org_new', url: 'x', ownerUserId: SYSTEM_USER.id });
    findFirstMock.mockResolvedValue(null);
    findFirstOrThrowMock.mockResolvedValue({ id: 5, organisationId: 'org_new' });
    createApiTokenMock.mockResolvedValue({ id: 1, token: 'api_t' });

    await provisionOrganisation({ name: 'Tenant', externalReference: 'host_app:new' });

    expect(createOrganisationMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: OrganisationType.ORGANISATION }),
    );
    // A freshly created org already has type ORGANISATION and the schema
    // default includeSenderDetails=true, so no upgrade write is needed.
    expect(organisationUpdateMock).not.toHaveBeenCalled();
  });

  it('re-POST upgrades an existing PERSONAL org with sender details off to ORGANISATION + includeSenderDetails=true', async () => {
    const url = deriveOrganisationUrlFromExternalReference('host_app:legacy');

    findUniqueMock.mockResolvedValue(
      existingOrg('org_legacy', url, {
        type: OrganisationType.PERSONAL,
        organisationGlobalSettings: { includeSenderDetails: false },
      }),
    );
    findFirstMock.mockResolvedValue({ id: 7, organisationId: 'org_legacy' });
    apiTokenFindFirstMock.mockResolvedValue({ id: 1, teamId: 7 });

    const result = await provisionOrganisation({ name: 'Legacy', externalReference: 'host_app:legacy' });

    expect(result).toEqual({ organisationId: 'org_legacy', apiToken: null, created: false });
    expect(organisationUpdateMock).toHaveBeenCalledWith({
      where: { id: 'org_legacy' },
      data: {
        type: OrganisationType.ORGANISATION,
        organisationGlobalSettings: { update: { includeSenderDetails: true } },
        organisationClaim: { update: { originalSubscriptionClaimId: 'platform' } },
      },
    });
  });

  it('re-POST re-stamps the PLATFORM claim the on-behalf-of resolver keys provenance on', async () => {
    const url = deriveOrganisationUrlFromExternalReference('host_app:reclaimed');

    findUniqueMock.mockResolvedValue(
      existingOrg('org_reclaimed', url, { organisationClaim: { originalSubscriptionClaimId: 'free' } }),
    );
    findFirstMock.mockResolvedValue({ id: 7, organisationId: 'org_reclaimed' });
    apiTokenFindFirstMock.mockResolvedValue({ id: 1, teamId: 7 });

    await provisionOrganisation({ name: 'Reclaimed', externalReference: 'host_app:reclaimed' });

    expect(organisationUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'org_reclaimed' },
        data: expect.objectContaining({
          organisationClaim: { update: { originalSubscriptionClaimId: 'platform' } },
        }),
      }),
    );
  });

  it('rejects a url collision with a non-Reeve-owned org before stamping the claim, type, or webhook', async () => {
    const url = deriveOrganisationUrlFromExternalReference('host_app:squatted');

    // A foreign org's manager set their url to the derived value.
    findUniqueMock.mockResolvedValue(
      existingOrg('org_foreign', url, {
        ownerUserId: 123,
        owner: { email: 'someone@example.com' },
        type: OrganisationType.PERSONAL,
        organisationClaim: { originalSubscriptionClaimId: 'free' },
      }),
    );

    const err = await provisionOrganisation({
      name: 'Squatted',
      externalReference: 'host_app:squatted',
      webhook: WEBHOOK,
    }).catch((e: unknown) => e);

    expect((err as AppError).code).toBe(AppErrorCode.ALREADY_EXISTS);
    expect(organisationUpdateMock).not.toHaveBeenCalled();
    expect(webhookCreateMock).not.toHaveBeenCalled();
    expect(webhookUpdateMock).not.toHaveBeenCalled();
    expect(createApiTokenMock).not.toHaveBeenCalled();
  });

  it('matches the system-user owner email case-insensitively', async () => {
    const url = deriveOrganisationUrlFromExternalReference('host_app:case');

    vi.stubEnv('REEVE_SIGN_SYSTEM_USER_EMAIL', ' Reeve-Provisioner@MeetReeve.com ');
    findUniqueMock.mockResolvedValue(existingOrg('org_case', url));
    findFirstMock.mockResolvedValue({ id: 7, organisationId: 'org_case' });
    apiTokenFindFirstMock.mockResolvedValue({ id: 1, teamId: 7 });

    const result = await provisionOrganisation({ name: 'Case', externalReference: 'host_app:case' });

    expect(result).toEqual({ organisationId: 'org_case', apiToken: null, created: false });
  });

  it('fails loud with NOT_SETUP on an existing org when REEVE_SIGN_SYSTEM_USER_EMAIL is unset', async () => {
    const url = deriveOrganisationUrlFromExternalReference('host_app:noenv');

    vi.stubEnv('REEVE_SIGN_SYSTEM_USER_EMAIL', '');
    findUniqueMock.mockResolvedValue(existingOrg('org_noenv', url, { type: OrganisationType.PERSONAL }));

    const err = await provisionOrganisation({ name: 'No Env', externalReference: 'host_app:noenv' }).catch(
      (e: unknown) => e,
    );

    expect((err as AppError).code).toBe(AppErrorCode.NOT_SETUP);
    expect(organisationUpdateMock).not.toHaveBeenCalled();
  });

  it('rejects a create race lost to a non-Reeve-owned org', async () => {
    const url = deriveOrganisationUrlFromExternalReference('host_app:race-foreign');

    findUniqueMock.mockResolvedValueOnce(null);
    createOrganisationMock.mockRejectedValueOnce(
      new AppError(AppErrorCode.ALREADY_EXISTS, { message: 'Organisation URL already exists' }),
    );
    findUniqueOrThrowMock.mockResolvedValueOnce({ id: 'org_foreign', url, owner: { email: 'someone@example.com' } });

    const err = await provisionOrganisation({
      name: 'Race Foreign',
      externalReference: 'host_app:race-foreign',
      webhook: WEBHOOK,
    }).catch((e: unknown) => e);

    expect((err as AppError).code).toBe(AppErrorCode.ALREADY_EXISTS);
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(webhookCreateMock).not.toHaveBeenCalled();
  });

  it('does not write when an existing org is already ORGANISATION with sender details on', async () => {
    const url = deriveOrganisationUrlFromExternalReference('host_app:ok');

    findUniqueMock.mockResolvedValue(existingOrg('org_ok', url));
    findFirstMock.mockResolvedValue({ id: 7, organisationId: 'org_ok' });
    apiTokenFindFirstMock.mockResolvedValue({ id: 1, teamId: 7 });

    await provisionOrganisation({ name: 'Ok', externalReference: 'host_app:ok' });

    expect(organisationUpdateMock).not.toHaveBeenCalled();
  });

  describe('webhook ensure', () => {
    it('creates the team webhook with the reeve-agents event set when none exists', async () => {
      findUniqueMock.mockResolvedValue(null);
      createOrganisationMock.mockResolvedValue({ id: 'org_wh', url: 'x', ownerUserId: SYSTEM_USER.id });
      findFirstMock.mockResolvedValue(null);
      findFirstOrThrowMock.mockResolvedValue({ id: 31, organisationId: 'org_wh' });
      createApiTokenMock.mockResolvedValue({ id: 1, token: 'api_t' });
      webhookFindFirstMock.mockResolvedValue(null);

      await provisionOrganisation({ name: 'Webhook Org', externalReference: 'host_app:wh', webhook: WEBHOOK });

      // Serialised per (team, url) so concurrent re-POSTs can't both create.
      expect(executeRawMock).toHaveBeenCalledTimes(1);
      expect(executeRawMock.mock.calls[0].slice(1)).toEqual([`reeve-webhook:31:${WEBHOOK.url}`]);
      expect(webhookFindFirstMock).toHaveBeenCalledWith({ where: { teamId: 31, webhookUrl: WEBHOOK.url } });
      expect(webhookCreateMock).toHaveBeenCalledWith({
        data: {
          webhookUrl: WEBHOOK.url,
          secret: WEBHOOK.secret,
          eventTriggers: REEVE_AGENTS_WEBHOOK_EVENTS,
          enabled: true,
          userId: SYSTEM_USER.id,
          teamId: 31,
        },
      });
    });

    it('is idempotent: an identical webhook already on the team is left alone', async () => {
      const url = deriveOrganisationUrlFromExternalReference('host_app:wh2');

      findUniqueMock.mockResolvedValue(existingOrg('org_wh2', url));
      findFirstMock.mockResolvedValue({ id: 32, organisationId: 'org_wh2' });
      apiTokenFindFirstMock.mockResolvedValue({ id: 1, teamId: 32 });
      webhookFindFirstMock.mockResolvedValue({
        id: 'wh_1',
        webhookUrl: WEBHOOK.url,
        secret: WEBHOOK.secret,
        // Same set, different order -> still identical.
        eventTriggers: [...REEVE_AGENTS_WEBHOOK_EVENTS].reverse(),
        enabled: true,
      });

      const result = await provisionOrganisation({
        name: 'Webhook Org',
        externalReference: 'host_app:wh2',
        webhook: WEBHOOK,
      });

      expect(result.created).toBe(false);
      expect(webhookCreateMock).not.toHaveBeenCalled();
      expect(webhookUpdateMock).not.toHaveBeenCalled();
    });

    it('re-POST updates a drifted webhook (secret, events, disabled) in place instead of duplicating it', async () => {
      const url = deriveOrganisationUrlFromExternalReference('host_app:wh3');

      findUniqueMock.mockResolvedValue(existingOrg('org_wh3', url));
      findFirstMock.mockResolvedValue({ id: 33, organisationId: 'org_wh3' });
      apiTokenFindFirstMock.mockResolvedValue({ id: 1, teamId: 33 });
      webhookFindFirstMock.mockResolvedValue({
        id: 'wh_old',
        webhookUrl: WEBHOOK.url,
        secret: 'old-secret',
        eventTriggers: [WebhookTriggerEvents.DOCUMENT_COMPLETED],
        enabled: false,
      });

      await provisionOrganisation({ name: 'Webhook Org', externalReference: 'host_app:wh3', webhook: WEBHOOK });

      expect(webhookCreateMock).not.toHaveBeenCalled();
      expect(webhookUpdateMock).toHaveBeenCalledWith({
        where: { id: 'wh_old' },
        data: { secret: WEBHOOK.secret, eventTriggers: REEVE_AGENTS_WEBHOOK_EVENTS, enabled: true },
      });
    });

    it('touches no webhook when none is requested', async () => {
      const url = deriveOrganisationUrlFromExternalReference('host_app:nowh');

      findUniqueMock.mockResolvedValue(existingOrg('org_nowh', url));
      findFirstMock.mockResolvedValue({ id: 34, organisationId: 'org_nowh' });
      apiTokenFindFirstMock.mockResolvedValue({ id: 1, teamId: 34 });

      await provisionOrganisation({ name: 'No Webhook', externalReference: 'host_app:nowh' });

      expect(webhookFindFirstMock).not.toHaveBeenCalled();
      expect(webhookCreateMock).not.toHaveBeenCalled();
    });
  });
});
