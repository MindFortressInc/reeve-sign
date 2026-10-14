import { i18n } from '@lingui/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recipientMetaTags } from './meta';

type Tag = { title?: string; name?: string; property?: string; content?: string };

const byKey = (tags: Tag[], key: 'property' | 'name', value: string) =>
  tags.filter((tag) => tag[key] === value).map((tag) => tag.content);

// DEV-15770: /sign/<token> (and every child page, which inherits the
// _recipient+ layout's meta) must unfurl with Reeve.Sign art, stay
// noindex, and never carry anything recipient-specific.
describe('recipientMetaTags', () => {
  beforeEach(() => {
    // Compiled catalogs are a build artefact; source-language descriptors
    // render identically with an empty 'en' catalog.
    i18n.load('en', {});
    i18n.activate('en');
    vi.stubEnv('NEXT_PUBLIC_WEBAPP_URL', 'https://sign.meetreeve.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('emits Reeve.Sign OG + twitter tags pointing at the site OG image', () => {
    const tags: Tag[] = recipientMetaTags();

    expect(byKey(tags, 'property', 'og:title')).toEqual(['Reeve.Sign']);
    expect(byKey(tags, 'property', 'og:description')).toEqual(['Reeve.Sign — fast, secure document signing.']);
    expect(byKey(tags, 'property', 'og:image')).toEqual(['https://sign.meetreeve.com/opengraph-image.jpg']);
    expect(byKey(tags, 'name', 'twitter:card')).toEqual(['summary_large_image']);
    expect(byKey(tags, 'name', 'twitter:image')).toEqual(['https://sign.meetreeve.com/opengraph-image.jpg']);
  });

  it('keeps the signing title and a single noindex robots tag', () => {
    const tags: Tag[] = recipientMetaTags();

    expect(tags.filter((tag) => 'title' in tag).map((tag) => tag.title)).toEqual(['Sign Document - Reeve.Sign']);
    expect(byKey(tags, 'name', 'robots')).toEqual(['noindex, nofollow, noarchive, nosnippet, noimageindex']);
  });

  it('carries no Documenso branding', () => {
    expect(JSON.stringify(recipientMetaTags()).toLowerCase()).not.toContain('documenso');
  });
});
