import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { uploadEmbedAuthoringPdf } from './embed-authoring-upload';

/**
 * DEV-12801: `/api/files/upload-pdf` now needs a session or an embedding
 * presign token. The V1 authoring iframe (Reeve's sign-embed app frames
 * /embed/v1/authoring/*) has no session cookie, so its PDF upload must carry
 * the `?token=` the layout verified as `Authorization: Bearer`.
 */
describe('uploadEmbedAuthoringPdf', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'dd_1', type: 'S3_PATH' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const pdf = {
    name: 'contract.pdf',
    type: 'application/pdf',
    arrayBuffer: async () => Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer),
  };

  it('sends the embedding presign token from the iframe URL as a Bearer header', async () => {
    const result = await uploadEmbedAuthoringPdf(pdf, '?token=presign_abc&foo=bar');

    expect(result).toEqual({ id: 'dd_1', type: 'S3_PATH' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe('/api/files/upload-pdf');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer presign_abc' });
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('sends no Authorization header when the URL has no token', async () => {
    await uploadEmbedAuthoringPdf(pdf, '');

    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
  });
});

describe('embed authoring create pages', () => {
  const routesDir = path.resolve(__dirname, '../routes/embed+/v1+/authoring+');

  it.each([
    'document.create.tsx',
    'template.create.tsx',
  ])('%s uploads through uploadEmbedAuthoringPdf (Bearer-carrying), never a bare putPdfFile', (file) => {
    const source = readFileSync(path.join(routesDir, file), 'utf8');

    expect(source).toMatch(/uploadEmbedAuthoringPdf\(/);
    expect(source).not.toMatch(/\bputPdfFile\b/);
  });
});
