import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../errors/app-error';
import { downloadFile } from './download-file';
import { downloadPDF } from './download-pdf';

vi.mock('./download-file', () => ({ downloadFile: vi.fn() }));

const envelopeItem = { id: 'item_1', envelopeId: 'env_1' };

describe('downloadPDF', () => {
  beforeEach(() => {
    vi.mocked(downloadFile).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws an AppError and saves nothing when the files route returns 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Envelope item not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const promise = downloadPDF({ envelopeItem, token: 'tok', fileName: 'Contract.pdf' });

    await expect(promise).rejects.toBeInstanceOf(AppError);
    await expect(promise).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND, statusCode: 404 });
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('throws UNKNOWN_ERROR and saves nothing on a 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));

    await expect(downloadPDF({ envelopeItem, token: undefined, version: 'original' })).rejects.toMatchObject({
      code: AppErrorCode.UNKNOWN_ERROR,
      statusCode: 500,
    });
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('saves the PDF blob with the version suffix on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('%PDF-1.7', { status: 200, headers: { 'Content-Type': 'application/pdf' } })),
    );

    await downloadPDF({ envelopeItem, token: 'tok', fileName: 'Contract.pdf' });

    expect(downloadFile).toHaveBeenCalledTimes(1);
    const [{ filename, data }] = vi.mocked(downloadFile).mock.calls[0];
    expect(filename).toBe('Contract_signed.pdf');
    expect(await data.text()).toBe('%PDF-1.7');
  });
});
