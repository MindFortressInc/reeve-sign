import { z } from 'zod';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { ensureOrganisationMember } from './ensure-organisation-member';
import {
  isReeveAdminProvisioningConfigured,
  isReeveAdminTokenValid,
  REEVE_ADMIN_TOKEN_HEADER,
} from './reeve-admin-token';

const ZEnsureOrganisationMemberRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().min(1, 'name is required').max(255),
});

/**
 * Handles `POST /api/reeve-admin/organisations/{external_reference}/members`
 * (DEV-12502): idempotently ensures a Documenso user plus MEMBER role on the
 * org's team, returning `{user_id, created}`. Same fail-closed admin-token
 * gate as `handleProvisionOrganisationRequest`.
 */
export const handleEnsureOrganisationMemberRequest = async (
  req: Request,
  externalReference: string,
): Promise<Response> => {
  if (!isReeveAdminProvisioningConfigured()) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  if (!isReeveAdminTokenValid(req.headers.get(REEVE_ADMIN_TOKEN_HEADER))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let rawBody: unknown;

  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = ZEnsureOrganisationMemberRequestSchema.safeParse(rawBody);

  if (!parsed.success) {
    return Response.json({ error: 'Invalid request body', details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await ensureOrganisationMember({ externalReference, ...parsed.data });

    return Response.json({ user_id: result.userId, created: result.created }, { status: 200 });
  } catch (err) {
    if (err instanceof AppError && err.code === AppErrorCode.NOT_FOUND) {
      return Response.json({ error: 'Organisation not found' }, { status: 404 });
    }

    console.error(err);

    return Response.json({ error: 'Failed to ensure organisation member' }, { status: 500 });
  }
};
