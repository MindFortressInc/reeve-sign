import { z } from 'zod';

import { provisionOrganisation } from './provision-organisation';
import {
  isReeveAdminProvisioningConfigured,
  isReeveAdminTokenValid,
  REEVE_ADMIN_TOKEN_HEADER,
} from './reeve-admin-token';

// Bounds kept in sync with `ZOrganisationNameSchema` in
// packages/trpc/server/organisation-router/create-organisation.types.ts so
// this REST path and the session tRPC path validate `name` identically.
const ZProvisionOrganisationRequestSchema = z.object({
  name: z.string().trim().min(3, 'name must be at least 3 characters').max(50, 'name must be at most 50 characters'),
  external_reference: z.string().trim().min(1, 'external_reference is required').max(512),
});

/**
 * Handles `POST /api/reeve-admin/organisations` (DEV-4873): a service-token
 * guarded REST endpoint that idempotently provisions a Documenso
 * organisation per host_app tenant and mints an org-scoped API token.
 *
 * Deliberately kept OUT of the public/session tRPC OpenAPI surface — see
 * `packages/trpc/server/organisation-router/create-organisation.ts`, whose
 * `createOrganisationMeta` stays commented out. This is a dedicated,
 * service-token-guarded app route instead.
 *
 * Fails closed: if `REEVE_SIGN_ADMIN_TOKEN` is unset the endpoint reports as
 * not found rather than merely unauthenticated, so there is never a window
 * where an unset env var means "open".
 */
export const handleProvisionOrganisationRequest = async (req: Request): Promise<Response> => {
  if (!isReeveAdminProvisioningConfigured()) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const providedToken = req.headers.get(REEVE_ADMIN_TOKEN_HEADER);

  if (!isReeveAdminTokenValid(providedToken)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let rawBody: unknown;

  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = ZProvisionOrganisationRequestSchema.safeParse(rawBody);

  if (!parsed.success) {
    return Response.json({ error: 'Invalid request body', details: parsed.error.flatten() }, { status: 400 });
  }

  const { name, external_reference: externalReference } = parsed.data;

  try {
    const result = await provisionOrganisation({ name, externalReference });

    return Response.json(
      {
        organisation_id: result.organisationId,
        api_token: result.apiToken,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (err) {
    console.error(err);

    return Response.json({ error: 'Failed to provision organisation' }, { status: 500 });
  }
};
