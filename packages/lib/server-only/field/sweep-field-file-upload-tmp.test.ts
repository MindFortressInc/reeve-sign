import { afterEach, describe, expect, it, vi } from 'vitest';

type Page = { key: string; lastModified: Date | null }[];

const listS3FilesByPrefix = vi.fn();
const deleteS3File = vi.fn();

vi.mock('../../universal/upload/server-actions', () => ({
  listS3FilesByPrefix: (...args: unknown[]) => listS3FilesByPrefix(...args),
  deleteS3File: (...args: unknown[]) => deleteS3File(...args),
}));

const { FIELD_FILE_UPLOAD_TMP_MAX_AGE_MS, isSweepableFieldFileUploadTmpKey, sweepFieldFileUploadTmp } = await import(
  './sweep-field-file-upload-tmp'
);

const NOW = new Date('2026-09-28T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - FIELD_FILE_UPLOAD_TMP_MAX_AGE_MS - 1);
const RECENT = new Date(NOW.getTime() - FIELD_FILE_UPLOAD_TMP_MAX_AGE_MS + 60_000);

const listPages = (pages: Page[]) => {
  listS3FilesByPrefix.mockImplementation(async function* () {
    for (const page of pages) {
      yield page;
    }
  });
};

afterEach(() => {
  vi.resetAllMocks();
});

describe('isSweepableFieldFileUploadTmpKey', () => {
  it('accepts a key strictly under the tmp prefix', () => {
    expect(isSweepableFieldFileUploadTmpKey('field-uploads-tmp/envelope_a/42/abcdefghijkl/license.pdf')).toBe(true);
  });

  it.each([
    ['a finalized key', 'field-uploads/envelope_a/42/abcdefghijkl/license.pdf'],
    ['a document key', 'abcdefghijkl/contract.pdf'],
    ['a look-alike prefix', 'field-uploads-tmp-other/envelope_a/42/x/license.pdf'],
    ['the bare prefix', 'field-uploads-tmp'],
    ['a parent-directory segment', 'field-uploads-tmp/../documents/contract.pdf'],
    ['a current-directory segment', 'field-uploads-tmp/./envelope_a/42/x/license.pdf'],
    ['an empty segment', 'field-uploads-tmp//envelope_a/42/x/license.pdf'],
    ['nothing after the prefix', 'field-uploads-tmp/'],
  ])('refuses %s', (_label, key) => {
    expect(isSweepableFieldFileUploadTmpKey(key)).toBe(false);
  });
});

describe('sweepFieldFileUploadTmp', () => {
  it('lists only the tmp prefix, with a trailing slash', async () => {
    listPages([]);

    await sweepFieldFileUploadTmp({ now: NOW });

    expect(listS3FilesByPrefix).toHaveBeenCalledWith('field-uploads-tmp/', { pageSize: undefined });
  });

  it('deletes objects older than the max age across every page, measured from LastModified', async () => {
    listPages([
      [
        { key: 'field-uploads-tmp/env_a/1/aaaaaaaaaaaa/a.pdf', lastModified: OLD },
        { key: 'field-uploads-tmp/env_a/1/bbbbbbbbbbbb/b.pdf', lastModified: RECENT },
      ],
      [{ key: 'field-uploads-tmp/env_b/2/cccccccccccc/c.png', lastModified: OLD }],
    ]);

    const result = await sweepFieldFileUploadTmp({ now: NOW });

    expect(deleteS3File.mock.calls).toEqual([
      ['field-uploads-tmp/env_a/1/aaaaaaaaaaaa/a.pdf'],
      ['field-uploads-tmp/env_b/2/cccccccccccc/c.png'],
    ]);
    expect(result).toEqual({ deleted: 2, kept: 1, refused: 0, failed: 0 });
  });

  it('keeps an object with no LastModified, since its age is unknown', async () => {
    listPages([[{ key: 'field-uploads-tmp/env_a/1/aaaaaaaaaaaa/a.pdf', lastModified: null }]]);

    const result = await sweepFieldFileUploadTmp({ now: NOW });

    expect(deleteS3File).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, kept: 1, refused: 0, failed: 0 });
  });

  it('never deletes a key outside the tmp prefix, even if the listing returns one', async () => {
    listPages([
      [
        { key: 'field-uploads/env_a/1/aaaaaaaaaaaa/final.pdf', lastModified: OLD },
        { key: 'abcdefghijkl/contract.pdf', lastModified: OLD },
        { key: 'field-uploads-tmp/../abcdefghijkl/contract.pdf', lastModified: OLD },
      ],
    ]);

    const result = await sweepFieldFileUploadTmp({ now: NOW });

    expect(deleteS3File).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, kept: 0, refused: 3, failed: 0 });
  });

  it('keeps sweeping after a delete fails', async () => {
    listPages([
      [
        { key: 'field-uploads-tmp/env_a/1/aaaaaaaaaaaa/a.pdf', lastModified: OLD },
        { key: 'field-uploads-tmp/env_a/1/bbbbbbbbbbbb/b.pdf', lastModified: OLD },
      ],
    ]);
    deleteS3File.mockRejectedValueOnce(new Error('AccessDenied'));

    const result = await sweepFieldFileUploadTmp({ now: NOW });

    expect(deleteS3File).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ deleted: 1, kept: 0, refused: 0, failed: 1 });
  });
});
