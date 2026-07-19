import { createHash } from 'node:crypto';

/**
 * Namespace prefix for organisation `url` slugs derived from a host_app's
 * `external_reference`. Keeps machine-provisioned org urls unambiguous from
 * human-picked ones and avoids any possibility of collision with them.
 */
const EXTERNAL_REFERENCE_URL_PREFIX = 'reeve-ext-';

/**
 * Deterministically derives an Organisation.url slug from a host_app's
 * `external_reference`. `Organisation.url` is a persistent, unique, `@db`
 * column (see packages/prisma/schema.prisma) that survives restarts, so
 * this doubles as the idempotency key for
 * `POST /api/reeve-admin/organisations`: the same `external_reference`
 * always derives the same url, so a lookup by url is sufficient to detect
 * "already provisioned" without any new schema/migration (DEV-4873).
 */
export const deriveOrganisationUrlFromExternalReference = (externalReference: string): string => {
  const hash = createHash('sha256').update(externalReference, 'utf8').digest('hex');

  return `${EXTERNAL_REFERENCE_URL_PREFIX}${hash}`;
};
