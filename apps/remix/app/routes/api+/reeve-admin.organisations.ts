// Service-token-guarded org-provisioning endpoint for Reeve tenants (DEV-4873).
// Deliberately NOT part of the public tRPC/OpenAPI surface — see
// packages/lib/server-only/reeve-admin/handle-provision-organisation-request.ts
// for the auth gate, idempotency, and billing-bypass logic.
import { handleProvisionOrganisationRequest } from '@documenso/lib/server-only/reeve-admin/handle-provision-organisation-request';

import type { Route } from './+types/reeve-admin.organisations';

export function action({ request }: Route.ActionArgs) {
  return handleProvisionOrganisationRequest(request);
}
