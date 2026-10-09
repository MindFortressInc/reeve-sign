import { WebhookTriggerEvents } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUniqueOrThrowMock, webhookCallCreateMock, executeWebhookCallMock } = vi.hoisted(() => ({
  findUniqueOrThrowMock: vi.fn(),
  webhookCallCreateMock: vi.fn(),
  executeWebhookCallMock: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    webhook: { findUniqueOrThrow: findUniqueOrThrowMock },
    webhookCall: { create: webhookCallCreateMock },
  },
}));

vi.mock('@documenso/lib/server-only/webhooks/execute-webhook-call', () => ({
  executeWebhookCall: executeWebhookCallMock,
}));

import { run } from './execute-webhook.handler';

const io = {} as Parameters<typeof run>[0]['io'];

const payload = { event: WebhookTriggerEvents.DOCUMENT_COMPLETED, webhookId: 'wh_1', data: { id: 1 } };

describe('execute-webhook handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeWebhookCallMock.mockResolvedValue({
      success: true,
      responseCode: 200,
      responseBody: null,
      responseHeaders: {},
    });
  });

  it('skips delivery when the webhook was disabled after the job was queued', async () => {
    findUniqueOrThrowMock.mockResolvedValue({ id: 'wh_1', enabled: false, webhookUrl: 'https://old', secret: 's' });

    await expect(run({ payload, io })).resolves.toEqual({ success: false, skipped: true });

    expect(executeWebhookCallMock).not.toHaveBeenCalled();
    expect(webhookCallCreateMock).not.toHaveBeenCalled();
  });

  it('still delivers an explicit manual resend to a disabled webhook', async () => {
    findUniqueOrThrowMock.mockResolvedValue({ id: 'wh_1', enabled: false, webhookUrl: 'https://old', secret: 's' });

    await run({ payload: { ...payload, isResend: true }, io });

    expect(executeWebhookCallMock).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://old', secret: 's' }));
    expect(webhookCallCreateMock).toHaveBeenCalledOnce();
  });

  it('delivers to an enabled webhook', async () => {
    findUniqueOrThrowMock.mockResolvedValue({ id: 'wh_1', enabled: true, webhookUrl: 'https://new', secret: 's' });

    await expect(run({ payload, io })).resolves.toEqual({ success: true, status: 200 });

    expect(executeWebhookCallMock).toHaveBeenCalledOnce();
  });
});
