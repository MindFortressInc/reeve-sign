/**
 * Real-Postgres integration test for the anonymous direct-template FILE_UPLOAD
 * presign. Real database for the template/field lookups AND for the
 * DB-backed rate limiter (`RateLimit` rows), since the per-IP and per-token
 * bounds are this endpoint's whole abuse story. The presigned URL itself is
 * signed locally by the AWS SDK (no network call), so no MinIO is needed.
 *
 * Opt-in only, via RUN_DB_INTEGRATION_TESTS=true — see
 * conditional-visibility-consent.integration.test.ts for the rationale.
 *
 *   RUN_DB_INTEGRATION_TESTS=true npx dotenv -e ../../.env -- \
 *     npx vitest run --config vitest.db-integration.config.ts
 */
import { prisma } from '@documenso/prisma';
import { seedTeam } from '@documenso/prisma/seed/teams';
import { seedDirectTemplate } from '@documenso/prisma/seed/templates';
import type { Field } from '@prisma/client';
import { FieldType, RecipientRole } from '@prisma/client';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { buildFieldFileUploadTmpKeyPrefix, FIELD_FILE_UPLOAD_SIZE_LIMIT_MB } from '../../types/field-file-upload';
import { createDocumentAuthOptions } from '../../utils/document-auth';
import {
  DIRECT_TEMPLATE_FILE_UPLOAD_MAX_PER_IP,
  DIRECT_TEMPLATE_FILE_UPLOAD_MAX_PER_TOKEN,
} from '../rate-limit/rate-limits';
import { presignDirectTemplateFieldFileUpload } from './presign-direct-template-field-file-upload';

const RUN_INTEGRATION = process.env.RUN_DB_INTEGRATION_TESTS === 'true';

// Rate-limit buckets are hourly and live in the database, so every test uses
// fresh IPs (and a fresh template, hence a fresh link token) to stay isolated
// from other tests and from earlier runs in the same hour.
const freshIp = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}-${nanoid(6)}`;

let ownerId: number;
let teamId: number;

describe.skipIf(!RUN_INTEGRATION)('presignDirectTemplateFieldFileUpload (real Postgres)', () => {
  beforeAll(async () => {
    const { owner, team } = await seedTeam();

    ownerId = owner.id;
    teamId = team.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const createField = async (
    template: { id: string },
    recipientId: number,
    type: FieldType,
    fieldMeta?: Field['fieldMeta'],
  ) => {
    const envelopeItem = await prisma.envelopeItem.findFirstOrThrow({ where: { envelopeId: template.id } });

    return await prisma.field.create({
      data: {
        envelopeId: template.id,
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
        fieldMeta: fieldMeta ?? undefined,
      },
    });
  };

  const seedUploadTemplate = async (internalVersion: 1 | 2 = 2) => {
    const template = await seedDirectTemplate({ userId: ownerId, teamId, internalVersion });

    const directRecipientId = template.directLink?.directTemplateRecipientId;

    if (!directRecipientId || !template.directLink) {
      throw new Error('Direct template recipient/link not found');
    }

    const uploadField = await createField(template, directRecipientId, FieldType.FILE_UPLOAD);

    return { template, directRecipientId, directLinkToken: template.directLink.token, uploadField };
  };

  const presign = async (directTemplateToken: string, fieldId: number, overrides: Record<string, unknown> = {}) =>
    presignDirectTemplateFieldFileUpload({
      directTemplateToken,
      fieldId,
      fileName: 'drivers license.pdf',
      contentType: 'application/pdf',
      fileSize: 1024,
      ipAddress: freshIp(),
      ...overrides,
    });

  it("mints a tmp key scoped to the template's own envelope and field", async () => {
    const { template, directLinkToken, uploadField } = await seedUploadTemplate();

    const { key, url } = await presign(directLinkToken, uploadField.id);

    expect(key.startsWith(buildFieldFileUploadTmpKeyPrefix({ envelopeId: template.id, fieldId: uploadField.id }))).toBe(
      true,
    );
    expect(key.endsWith('/drivers-license.pdf')).toBe(true);
    expect(decodeURIComponent(new URL(url).pathname)).toContain(key);
  });

  it("rejects another recipient's FILE_UPLOAD field on the same template", async () => {
    const { template, directLinkToken } = await seedUploadTemplate();

    const otherRecipient = await prisma.recipient.create({
      data: {
        envelopeId: template.id,
        email: `other-${nanoid()}@test.documenso.com`,
        name: 'Other',
        role: RecipientRole.SIGNER,
        token: nanoid(),
      },
    });
    const otherField = await createField(template, otherRecipient.id, FieldType.FILE_UPLOAD);

    await expect(presign(directLinkToken, otherField.id)).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });
  });

  it('rejects a FILE_UPLOAD field from a different template', async () => {
    const { directLinkToken } = await seedUploadTemplate();
    const { uploadField: foreignField } = await seedUploadTemplate();

    await expect(presign(directLinkToken, foreignField.id)).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });
  });

  it("rejects the direct recipient's non-FILE_UPLOAD field", async () => {
    const { template, directRecipientId, directLinkToken } = await seedUploadTemplate();
    const textField = await createField(template, directRecipientId, FieldType.TEXT);

    await expect(presign(directLinkToken, textField.id)).rejects.toMatchObject({
      code: AppErrorCode.INVALID_REQUEST,
    });
  });

  it('rejects a read-only FILE_UPLOAD field', async () => {
    const { template, directRecipientId, directLinkToken } = await seedUploadTemplate();
    const readOnlyField = await createField(template, directRecipientId, FieldType.FILE_UPLOAD, {
      type: 'file_upload',
      readOnly: true,
    });

    await expect(presign(directLinkToken, readOnlyField.id)).rejects.toMatchObject({
      code: AppErrorCode.INVALID_REQUEST,
    });
  });

  it('rejects a disabled direct link and an unknown token', async () => {
    const { template, directLinkToken, uploadField } = await seedUploadTemplate();

    await expect(presign(`unknown-${nanoid()}`, uploadField.id)).rejects.toMatchObject({
      code: AppErrorCode.NOT_FOUND,
    });

    await prisma.templateDirectLink.update({ where: { envelopeId: template.id }, data: { enabled: false } });

    await expect(presign(directLinkToken, uploadField.id)).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });
  });

  it('rejects a V1 template', async () => {
    const { directLinkToken, uploadField } = await seedUploadTemplate(1);

    await expect(presign(directLinkToken, uploadField.id)).rejects.toMatchObject({
      code: AppErrorCode.INVALID_REQUEST,
    });
  });

  it('requires a logged-in visitor when the template requires ACCOUNT access', async () => {
    const { template, directLinkToken, uploadField } = await seedUploadTemplate();

    await prisma.envelope.update({
      where: { id: template.id },
      data: { authOptions: createDocumentAuthOptions({ globalAccessAuth: ['ACCOUNT'], globalActionAuth: [] }) },
    });

    await expect(presign(directLinkToken, uploadField.id)).rejects.toMatchObject({
      code: AppErrorCode.UNAUTHORIZED,
    });

    await expect(presign(directLinkToken, uploadField.id, { userId: ownerId })).resolves.toMatchObject({
      key: expect.any(String),
    });
  });

  it('applies the shared upload policy (type allowlist, size ceiling)', async () => {
    const { directLinkToken, uploadField } = await seedUploadTemplate();

    await expect(presign(directLinkToken, uploadField.id, { contentType: 'text/html' })).rejects.toMatchObject({
      code: AppErrorCode.INVALID_BODY,
    });

    await expect(
      presign(directLinkToken, uploadField.id, { fileSize: FIELD_FILE_UPLOAD_SIZE_LIMIT_MB * 1024 * 1024 + 1 }),
    ).rejects.toMatchObject({ code: AppErrorCode.INVALID_BODY });
  });

  it(`limits one IP to ${DIRECT_TEMPLATE_FILE_UPLOAD_MAX_PER_IP} presigns per hour, across templates`, async () => {
    const first = await seedUploadTemplate();
    const second = await seedUploadTemplate();
    const ipAddress = freshIp();

    for (let i = 0; i < DIRECT_TEMPLATE_FILE_UPLOAD_MAX_PER_IP; i++) {
      await presign(first.directLinkToken, first.uploadField.id, { ipAddress });
    }

    await expect(presign(second.directLinkToken, second.uploadField.id, { ipAddress })).rejects.toMatchObject({
      code: AppErrorCode.TOO_MANY_REQUESTS,
    });

    // A different IP is unaffected.
    await expect(presign(second.directLinkToken, second.uploadField.id)).resolves.toMatchObject({
      key: expect.any(String),
    });
  });

  it(`limits one link token to ${DIRECT_TEMPLATE_FILE_UPLOAD_MAX_PER_TOKEN} presigns per hour, across IPs`, async () => {
    const { directLinkToken, uploadField } = await seedUploadTemplate();

    for (let i = 0; i < DIRECT_TEMPLATE_FILE_UPLOAD_MAX_PER_TOKEN; i++) {
      await presign(directLinkToken, uploadField.id);
    }

    await expect(presign(directLinkToken, uploadField.id)).rejects.toMatchObject({
      code: AppErrorCode.TOO_MANY_REQUESTS,
    });
  }, 60_000);
});
