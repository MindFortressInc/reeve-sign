import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// DEV-15770: link previews for /share/<slug> rendered Documenso's
// "Join Documenso" frame + logo because the DEV-2836 reskin replaced
// opengraph-image.jpg but not the share-card frame. These are the sha256s of
// the upstream Documenso art; an upstream sync that restores any of them
// fails here instead of shipping Documenso branding to every unfurl.
const UPSTREAM_DOCUMENSO_SHA256 = new Set([
  '74f6049b8c5d47f02e345f32fba0049b2e12cebbb25f3ee0078928606b66c889', // og-share-frame2.png
  '671b0866c57535dd9423adcd6250b336d33a23d8e49173b2d4daad4da9d6c2d8', // og-share-frame.png
  'a004b3b0a88c53f7383d1ed98ac1434115f6178d6a740280fb8d6d62ebe96463', // opengraph-image.jpg
]);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const OG_ASSETS = [
  'apps/remix/public/opengraph-image.jpg',
  'apps/remix/public/static/og-share-frame2.png',
  'packages/assets/opengraph-image.jpg',
  'packages/assets/static/og-share-frame.png',
  'packages/assets/static/og-share-frame2.png',
];

const read = (path: string) => readFileSync(resolve(REPO_ROOT, path));
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

describe('OG / link-preview brand assets', () => {
  it.each(OG_ASSETS)('%s is not upstream Documenso art', (path) => {
    expect(UPSTREAM_DOCUMENSO_SHA256.has(sha256(read(path)))).toBe(false);
  });

  // share.$slug.opengraph.tsx stretches the frame to 1200x630 and positions
  // the dynamic card with fixed CARD_* offsets, so the frame must be exactly
  // that size for the card window to line up.
  it('served share frame is a 1200x630 PNG', () => {
    const png = read('apps/remix/public/static/og-share-frame2.png');

    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });
});
