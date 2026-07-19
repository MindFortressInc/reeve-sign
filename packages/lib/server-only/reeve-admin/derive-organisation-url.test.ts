import { describe, expect, it } from 'vitest';

import { deriveOrganisationUrlFromExternalReference } from './derive-organisation-url';

describe('deriveOrganisationUrlFromExternalReference', () => {
  it('is deterministic for the same external_reference', () => {
    const first = deriveOrganisationUrlFromExternalReference('host_app:tenant-123');
    const second = deriveOrganisationUrlFromExternalReference('host_app:tenant-123');

    expect(first).toBe(second);
  });

  it('produces different urls for different external references', () => {
    const a = deriveOrganisationUrlFromExternalReference('host_app:tenant-123');
    const b = deriveOrganisationUrlFromExternalReference('host_app:tenant-456');

    expect(a).not.toBe(b);
  });

  it('is namespaced so it cannot collide with human-picked organisation urls', () => {
    const url = deriveOrganisationUrlFromExternalReference('tenant-123');

    expect(url.startsWith('reeve-ext-')).toBe(true);
  });

  it('is sensitive to the exact external_reference value (no truncation collisions)', () => {
    const a = deriveOrganisationUrlFromExternalReference('a');
    const b = deriveOrganisationUrlFromExternalReference('a ');

    expect(a).not.toBe(b);
  });
});
