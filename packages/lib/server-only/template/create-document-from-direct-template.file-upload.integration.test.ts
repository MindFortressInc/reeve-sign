/**
 * End-to-end FILE_UPLOAD on a direct (public-link) template, against a REAL
 * Postgres and a REAL S3-compatible store (MinIO), no mocks on either:
 *
 *   presignDirectTemplateFieldFileUpload -> real HTTP PUT of the bytes to the
 *   presigned URL -> createDocumentFromDirectTemplate -> finalizeFieldFileUpload
 *
 * Proves the submitted tmp key is ownership-checked against the template
 * field, finalized to an immutable key under the NEW envelope, that the tmp
 * object is removed, that content verification (magic bytes) applies, that
 * finalization (S3 I/O) never runs inside the DB transaction, and that a
 * transaction failure after finalization deletes the final copy.
 *
 * Mock boundary, same as create-document-from-direct-template.integration.test.ts:
 * `sendDocument`, `triggerWebhook` and `jobs.triggerJob` only.
 * `finalizeFieldFileUpload` and `prisma.$transaction` are wrapped (pass-through,
 * never replaced) only to record whether finalize ran inside the transaction.
 *
 * Needs BOTH stores, so it self-gates on BOTH flags:
 *
 *   RUN_DB_INTEGRATION_TESTS=true RUN_S3_INTEGRATION_TESTS=true npx dotenv -e ../../.env -- \
 *     npx vitest run --config vitest.integration.config.ts
 */
import { prisma } from '@documenso/prisma';
import { seedTeam } from '@documenso/prisma/seed/teams';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import { FieldType } from '@prisma/client';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildFieldFileUploadKeyPrefix,
  parseFileUploadCustomText,
  toFileUploadCustomText,
} from '../../types/field-file-upload';
import { headS3File, listS3FilesByPrefix } from '../../universal/upload/server-actions';
import { createDocumentFromDirectTemplate } from './create-document-from-direct-template';
import { presignDirectTemplateFieldFileUpload } from './presign-direct-template-field-file-upload';

const RUN_INTEGRATION =
  process.env.RUN_DB_INTEGRATION_TESTS === 'true' && process.env.RUN_S3_INTEGRATION_TESTS === 'true';

vi.mock('../document/send-document', () => ({ sendDocument: vi.fn() }));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));
vi.mock('@documenso/lib/jobs/client', () => ({ jobs: { triggerJob: vi.fn() } }));

// Records, for each real finalize call, whether a `prisma.$transaction`
// callback was running at the time (see the wrapper installed in beforeAll).
const transactionProbe = vi.hoisted(() => ({ depth: 0, finalizeInsideTransaction: [] as boolean[] }));

// The exported client is an extended Prisma client (a Proxy), so
// `vi.spyOn(prisma, '$transaction')` can't reach it. Wrap it instead: every
// property passes through, and `$transaction(callback)` runs the real
// transaction while tracking whether the callback is executing.
vi.mock('@documenso/prisma', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@documenso/prisma')>();
  const client = actual.prisma;

  const trackedTransaction = (arg: unknown, options?: unknown) => {
    if (typeof arg !== 'function') {
      return client.$transaction(arg as never, options as never);
    }

    return client.$transaction(async (tx: unknown) => {
      transactionProbe.depth += 1;

      try {
        return await (arg as (tx: unknown) => Promise<unknown>)(tx);
      } finally {
        transactionProbe.depth -= 1;
      }
    }, options as never);
  };

  return {
    ...actual,
    prisma: new Proxy(client, {
      get: (target, prop) => (prop === '$transaction' ? trackedTransaction : Reflect.get(target, prop)),
    }),
  };
});

vi.mock('../field/finalize-field-file-upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../field/finalize-field-file-upload')>();

  return {
    ...actual,
    finalizeFieldFileUpload: async (...args: Parameters<typeof actual.finalizeFieldFileUpload>) => {
      transactionProbe.finalizeInsideTransaction.push(transactionProbe.depth > 0);

      return actual.finalizeFieldFileUpload(...args);
    },
  };
});

const REQUEST_METADATA = {
  requestMetadata: {},
  source: 'app' as const,
  auth: 'session' as const,
};

// Lowercase alphanumerics only, so the name survives the key's filename
// slugification unchanged and can be found in a bucket listing.
const uniqueSlug = () =>
  nanoid(8)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x');

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\nfake but well-signed pdf body\n');
const HTML_BYTES = new TextEncoder().encode('<html><script>alert(1)</script></html>');

let ownerId: number;
let teamId: number;

describe.skipIf(!RUN_INTEGRATION)('createDocumentFromDirectTemplate — FILE_UPLOAD (real Postgres + MinIO)', () => {
  beforeAll(async () => {
    const { owner, team } = await seedTeam();

    ownerId = owner.id;
    teamId = team.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const createField = async (templateId: string, recipientId: number, type: FieldType, required?: boolean) => {
    const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: templateId } });

    return await prisma.field.create({
      data: {
        envelopeId: templateId,
        envelopeItemId: envelopeItem.id,
        recipientId,
        type,
        page: 1,
        positionX: 0,
        positionY: 0,
        width: 5,
        height: 5,
        customText: '',
        inserted: false,
        fieldMeta: type === FieldType.TEXT ? { type: 'text', required } : undefined,
      },
    });
  };

  const seedUploadTemplate = async () => {
    const template = await seedDirectTemplate({ userId: ownerId, teamId, internalVersion: 2 });

    const directRecipientId = template.directLink?.directTemplateRecipientId;

    if (!directRecipientId || !template.directLink) {
      throw new Error('Direct template recipient/link not found');
    }

    const uploadField = await createField(template.id, directRecipientId, FieldType.FILE_UPLOAD);

    return { template, directRecipientId, directLinkToken: template.directLink.token, uploadField };
  };

  /** What the browser does: presign, then PUT the bytes to the URL. */
  const uploadViaPresign = async (
    directLinkToken: string,
    fieldId: number,
    bytes: Uint8Array,
    fileName = `license-${uniqueSlug()}.pdf`,
  ) => {
    const { key, url } = await presignDirectTemplateFieldFileUpload({
      directTemplateToken: directLinkToken,
      fieldId,
      fileName,
      contentType: 'application/pdf',
      fileSize: bytes.byteLength,
      ipAddress: `test-${nanoid()}`,
    });

    const response = await fetch(url, {
      method: 'PUT',
      body: bytes,
      headers: { 'Content-Type': 'application/pdf' },
    });

    expect(response.ok).toBe(true);

    return toFileUploadCustomText({ key, fileName, size: bytes.byteLength, mimeType: 'application/pdf' });
  };

  const submit = async (
    templateId: string,
    directLinkToken: string,
    signedFieldValues: { fieldId: number; value: string }[],
  ) => {
    const freshTemplate = await prisma.envelope.findUniqueOrThrow({ where: { id: templateId } });

    return await createDocumentFromDirectTemplate({
      directRecipientEmail: `direct-${nanoid()}@test.documenso.com`,
      directTemplateToken: directLinkToken,
      templateUpdatedAt: freshTemplate.updatedAt,
      requestMetadata: REQUEST_METADATA,
      signedFieldValues: signedFieldValues.map((value) => ({ token: '', isBase64: false, ...value })),
    });
  };

  const finalKeysEndingWith = async (fileName: string) => {
    const keys: string[] = [];

    for await (const page of listS3FilesByPrefix('field-uploads/')) {
      keys.push(...page.map(({ key }) => key).filter((key) => key.endsWith(`/${fileName}`)));
    }

    return keys;
  };

  it('finalizes the upload to an immutable key under the new envelope and removes the tmp object', async () => {
    const { template, directLinkToken, uploadField } = await seedUploadTemplate();

    const value = await uploadViaPresign(directLinkToken, uploadField.id, PDF_BYTES);
    const tmpKey = parseFileUploadCustomText(value)?.key ?? '';

    const result = await submit(template.id, directLinkToken, [{ fieldId: uploadField.id, value }]);

    const persisted = await prisma.field.findFirstOrThrow({
      where: { envelopeId: result.envelopeId, type: FieldType.FILE_UPLOAD },
    });
    const stored = parseFileUploadCustomText(persisted.customText);

    expect(persisted.inserted).toBe(true);
    expect(
      stored?.key.startsWith(buildFieldFileUploadKeyPrefix({ envelopeId: result.envelopeId, fieldId: uploadField.id })),
    ).toBe(true);
    expect(stored?.size).toBe(PDF_BYTES.byteLength);
    expect(stored?.mimeType).toBe('application/pdf');

    const finalHead = await headS3File(stored?.key ?? '');
    expect(finalHead).toMatchObject({ exists: true, size: PDF_BYTES.byteLength, contentType: 'application/pdf' });
    expect((await headS3File(tmpKey)).exists).toBe(false);

    const insertedAuditLog = await prisma.documentAuditLog.findFirst({
      where: { envelopeId: result.envelopeId, type: 'DOCUMENT_FIELD_INSERTED' },
    });
    expect(JSON.stringify(insertedAuditLog?.data)).toContain(stored?.key ?? 'missing');
  });

  it('finalizes uploads before the DB transaction, never inside it (no S3 I/O while holding row locks)', async () => {
    const { template, directLinkToken, uploadField } = await seedUploadTemplate();

    const value = await uploadViaPresign(directLinkToken, uploadField.id, PDF_BYTES);

    transactionProbe.finalizeInsideTransaction.length = 0;

    await submit(template.id, directLinkToken, [{ fieldId: uploadField.id, value }]);

    expect(transactionProbe.finalizeInsideTransaction).toEqual([false]);
  });

  it("rejects a tmp key minted for a different template's field", async () => {
    const { template, directLinkToken, uploadField } = await seedUploadTemplate();
    const other = await seedUploadTemplate();

    const foreignValue = await uploadViaPresign(other.directLinkToken, other.uploadField.id, PDF_BYTES);

    await expect(
      submit(template.id, directLinkToken, [{ fieldId: uploadField.id, value: foreignValue }]),
    ).rejects.toThrow(/does not belong to this field/);
  });

  it('rejects a FILE_UPLOAD value that is not a parseable upload claim', async () => {
    const { template, directLinkToken, uploadField } = await seedUploadTemplate();

    await expect(
      submit(template.id, directLinkToken, [{ fieldId: uploadField.id, value: 'field-uploads/anything.pdf' }]),
    ).rejects.toThrow(/Invalid file upload value/);
  });

  it('keeps FILE_UPLOAD required: an empty value blocks creation', async () => {
    const { template, directLinkToken, uploadField } = await seedUploadTemplate();

    await expect(submit(template.id, directLinkToken, [{ fieldId: uploadField.id, value: '' }])).rejects.toThrow(
      /Invalid, missing or changed fields/,
    );
  });

  it('rejects bytes that do not match the declared type, leaving no document and no final object', async () => {
    const { template, directLinkToken, uploadField } = await seedUploadTemplate();
    const fileName = `disguised-${uniqueSlug()}.pdf`;

    const value = await uploadViaPresign(directLinkToken, uploadField.id, HTML_BYTES, fileName);

    await expect(submit(template.id, directLinkToken, [{ fieldId: uploadField.id, value }])).rejects.toThrow(
      /does not match its declared type/,
    );

    expect(await prisma.field.count({ where: { customText: { contains: fileName } } })).toBe(0);
    expect(await finalKeysEndingWith(fileName)).toEqual([]);
  });

  it('deletes already-finalized uploads when a later upload fails to finalize', async () => {
    const { template, directRecipientId, directLinkToken, uploadField } = await seedUploadTemplate();
    const secondUploadField = await createField(template.id, directRecipientId, FieldType.FILE_UPLOAD);
    const goodFileName = `first-${uniqueSlug()}.pdf`;

    const goodValue = await uploadViaPresign(directLinkToken, uploadField.id, PDF_BYTES, goodFileName);
    const disguisedValue = await uploadViaPresign(directLinkToken, secondUploadField.id, HTML_BYTES);

    await expect(
      submit(template.id, directLinkToken, [
        { fieldId: uploadField.id, value: goodValue },
        { fieldId: secondUploadField.id, value: disguisedValue },
      ]),
    ).rejects.toThrow(/does not match its declared type/);

    expect(await finalKeysEndingWith(goodFileName)).toEqual([]);
  });

  it('deletes the finalized copy when the transaction fails after finalization', async () => {
    const { template, directRecipientId, directLinkToken, uploadField } = await seedUploadTemplate();
    // A required TEXT field submitted empty passes the pre-transaction checks
    // and is only caught by the authoritative in-transaction check, which runs
    // AFTER the upload has been finalized.
    const requiredText = await createField(template.id, directRecipientId, FieldType.TEXT, true);
    const fileName = `rollback-${uniqueSlug()}.pdf`;

    const value = await uploadViaPresign(directLinkToken, uploadField.id, PDF_BYTES, fileName);

    await expect(
      submit(template.id, directLinkToken, [
        { fieldId: uploadField.id, value },
        { fieldId: requiredText.id, value: '' },
      ]),
    ).rejects.toThrow(/Invalid, missing or changed fields/);

    expect(await finalKeysEndingWith(fileName)).toEqual([]);
  });
});
