// Service-token-guarded member-ensure endpoint for Reeve per-org senders
// (DEV-12502). See
// packages/lib/server-only/reeve-admin/handle-ensure-organisation-member-request.ts.
import { handleEnsureOrganisationMemberRequest } from '@documenso/lib/server-only/reeve-admin/handle-ensure-organisation-member-request';

import type { Route } from './+types/reeve-admin.organisations.$externalReference.members';

export function action({ request, params }: Route.ActionArgs) {
  return handleEnsureOrganisationMemberRequest(request, params.externalReference);
}
