import { setupI18n } from '@lingui/core';
import { DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors/app-error';

// DEV-18278: resendDocument asks reeve-services' fair-use admission before it
// extends any expiry or sends any reminder. Each resend is its own attempt
// (`resend:<uuid>`), so it spends its own slot. A refusal changes nothing.

const { prismaMock, sendMailMock, admitSignSendMock } = vi.hoisted(() => ({
  prismaMock: {
    envelope: { findUnique: vi.fn() },
    recipient: { updateMany: vi.fn() },
    documentAuditLog: { create: vi.fn() },
  },
  sendMailMock: vi.fn(),
  admitSignSendMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({ prisma: prismaMock }));
vi.mock('@documenso/email/mailer', () => ({ mailer: { sendMail: sendMailMock } }));
vi.mock('../sign-admission/admit-send', () => ({ admitSignSend: admitSignSendMock }));
vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: vi.fn(async () => ({ envelopeWhereInput: { id: 'envelope_abc' } })),
}));
vi.mock('../email/get-email-context', () => ({
  getEmailContext: vi.fn(async () => ({
    branding: undefined,
    emailLanguage: 'en',
    settings: { includeSenderDetails: false },
    organisationType: 'PERSONAL',
    senderEmail: { name: 'Reeve', address: 'noreply@sign.meetreeve.com' },
    replyToEmail: undefined,
  })),
}));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({ triggerWebhook: vi.fn() }));
vi.mock('../../types/webhook-payload', () => ({
  mapEnvelopeToWebhookDocumentPayload: vi.fn(),
  ZWebhookDocumentSchema: { parse: vi.fn() },
}));
vi.mock('../../client-only/providers/i18n-server', () => ({
  getI18nInstance: () => {
    const i18n = setupI18n({ locale: 'en', messages: { en: {} } });
    i18n.activate('en');

    return Promise.resolve(i18n);
  },
}));

const { resendDocument } = await import('./resend-document');

const ORG_URL = 'reeve-ext-0123abcd';

const ENVELOPE = {
  id: 'envelope_abc',
  secondaryId: 'document_42',
  userId: 5,
  teamId: 7,
  title: 'NDA',
  status: DocumentStatus.PENDING,
  documentMeta: { envelopeExpirationPeriod: null, message: '', subject: '', emailSettings: null },
  team: { teamEmail: null, name: 'Team', organisation: { url: ORG_URL } },
  user: { id: 5, email: 'owner@example.com', name: 'Owner' },
  recipients: [
    {
      id: 1,
      email: 'signer@example.com',
      name: 'Signer',
      token: 'tok_1',
      role: RecipientRole.SIGNER,
      signingStatus: SigningStatus.NOT_SIGNED,
    },
  ],
};

const OPTIONS = {
  id: { type: 'envelopeId' as const, id: 'envelope_abc' },
  userId: 5,
  teamId: 7,
  recipients: [1],
  requestMetadata: { requestMetadata: {}, source: 'app', auth: null } as never,
};

const ATTEMPT = /^resend:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => {
  prismaMock.envelope.findUnique.mockReset().mockResolvedValue(ENVELOPE);
  prismaMock.recipient.updateMany.mockReset();
  prismaMock.documentAuditLog.create.mockReset();
  sendMailMock.mockReset();
  admitSignSendMock.mockReset().mockResolvedValue({ enforced: true, account: 'org_1', consumed: true, replay: false });
});

describe('resendDocument fair-use admission (DEV-18278)', () => {
  it('admits each resend under a fresh resend:<uuid> attempt, before the reminder mail', async () => {
    const order: string[] = [];
    admitSignSendMock.mockImplementation(async () => {
      order.push('admit');
      return { enforced: true, account: 'org_1', consumed: true, replay: false };
    });
    sendMailMock.mockImplementation(async () => {
      order.push('mail');
    });

    await resendDocument(OPTIONS);
    await resendDocument(OPTIONS);

    expect(order).toEqual(['admit', 'mail', 'admit', 'mail']);

    const [first, second] = admitSignSendMock.mock.calls.map(([arg]) => arg as Record<string, unknown>);

    expect(first).toEqual({
      envelopeId: 'envelope_abc',
      legacyDocumentId: 42,
      organisationUrl: ORG_URL,
      attempt: expect.stringMatching(ATTEMPT),
    });
    expect(second.attempt).toEqual(expect.stringMatching(ATTEMPT));
    expect(second.attempt).not.toBe(first.attempt);
  });

  it('loads the envelope organisation url with the team', async () => {
    await resendDocument(OPTIONS);

    const [query] = prismaMock.envelope.findUnique.mock.calls[0] as [
      { include: { team: { select: Record<string, unknown> } } },
    ];

    expect(query.include.team.select.organisation).toEqual({ select: { url: true } });
  });

  it('a refusal propagates: no expiry change, no mail', async () => {
    prismaMock.envelope.findUnique.mockResolvedValue({
      ...ENVELOPE,
      documentMeta: { ...ENVELOPE.documentMeta, envelopeExpirationPeriod: { unit: 'day', amount: 7 } },
    });
    const refusal = new AppError('SIGN_ACCOUNT_SUSPENDED', { message: 'suspended', statusCode: 403 });
    admitSignSendMock.mockRejectedValue(refusal);

    await expect(resendDocument(OPTIONS)).rejects.toBe(refusal);
    expect(prismaMock.recipient.updateMany).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('spends no slot when nobody is left to remind', async () => {
    await resendDocument({ ...OPTIONS, recipients: [] });

    expect(admitSignSendMock).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
