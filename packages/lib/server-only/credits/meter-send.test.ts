import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../errors/app-error';

// vi.mock() calls are hoisted above imports by vitest's transform, so the
// mock fns must be created via vi.hoisted() to be safely referenceable
// inside the factory below.
const { reserveCreditsMock, commitReservationMock, voidReservationMock } = vi.hoisted(() => ({
  reserveCreditsMock: vi.fn(),
  commitReservationMock: vi.fn(),
  voidReservationMock: vi.fn(),
}));

vi.mock('./client', () => ({
  reserveCredits: reserveCreditsMock,
  commitReservation: commitReservationMock,
  voidReservation: voidReservationMock,
}));

import { meterDocumentSend } from './meter-send';

beforeEach(() => {
  reserveCreditsMock.mockReset();
  commitReservationMock.mockReset();
  voidReservationMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('meterDocumentSend — unconfigured (no env vars)', () => {
  it('is a pure no-op passthrough: sendFn runs, credits client is never called', async () => {
    vi.stubEnv('REEVE_CREDITS_API_URL', '');
    vi.stubEnv('REEVE_SIGN_HOST_KEY', '');

    const sendFn = vi.fn().mockResolvedValue('sent');

    const result = await meterDocumentSend({ userId: 42, envelopeId: 'envelope_abc' }, sendFn);

    expect(result).toBe('sent');
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(reserveCreditsMock).not.toHaveBeenCalled();
    expect(commitReservationMock).not.toHaveBeenCalled();
    expect(voidReservationMock).not.toHaveBeenCalled();
  });
});

describe('meterDocumentSend — configured', () => {
  beforeEach(() => {
    vi.stubEnv('REEVE_CREDITS_API_URL', 'https://api.meetreeve.com');
    vi.stubEnv('REEVE_SIGN_HOST_KEY', 'sign_hostkey_test123');
  });

  it('reserves credits with a stable per-envelope reference_id BEFORE sendFn runs, then commits on success', async () => {
    const callOrder: string[] = [];
    const sendFn = vi.fn().mockImplementation(() => {
      callOrder.push('sendFn');
      return Promise.resolve('sent');
    });
    reserveCreditsMock.mockImplementation(() => {
      callOrder.push('reserve');
      return Promise.resolve({ reservationId: 'res_1', reserved: 500 });
    });
    commitReservationMock.mockImplementation(() => {
      callOrder.push('commit');
      return Promise.resolve({ entryId: 'entry_1', committed: 500, reservationId: 'res_1' });
    });

    const result = await meterDocumentSend({ userId: 42, envelopeId: 'envelope_abc' }, sendFn);

    expect(result).toBe('sent');
    expect(callOrder).toEqual(['reserve', 'sendFn', 'commit']);

    expect(reserveCreditsMock).toHaveBeenCalledWith({
      ownerId: '42',
      amount: 500,
      referenceId: 'sign.send.envelope_abc',
      reason: 'sign.envelope.send',
    });
    expect(commitReservationMock).toHaveBeenCalledWith('res_1');
    expect(voidReservationMock).not.toHaveBeenCalled();
  });

  it('is idempotent per envelope: the same envelopeId always produces the same reference_id', async () => {
    reserveCreditsMock.mockResolvedValue({ reservationId: 'res_1', reserved: 500 });
    commitReservationMock.mockResolvedValue({ entryId: 'entry_1', committed: 500, reservationId: 'res_1' });

    await meterDocumentSend({ userId: 42, envelopeId: 'envelope_abc' }, async () => 'sent');
    await meterDocumentSend({ userId: 42, envelopeId: 'envelope_abc' }, async () => 'sent');

    expect(reserveCreditsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ referenceId: 'sign.send.envelope_abc' }),
    );
    expect(reserveCreditsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ referenceId: 'sign.send.envelope_abc' }),
    );
  });

  it('fails closed on insufficient credits: sendFn never runs, the AppError propagates', async () => {
    const insufficientError = new AppError('INSUFFICIENT_CREDITS', {
      userMessage: "You don't have enough credits.",
      statusCode: 402,
    });
    reserveCreditsMock.mockRejectedValue(insufficientError);

    const sendFn = vi.fn().mockResolvedValue('sent');

    await expect(meterDocumentSend({ userId: 42, envelopeId: 'envelope_abc' }, sendFn)).rejects.toBe(insufficientError);

    expect(sendFn).not.toHaveBeenCalled();
    expect(commitReservationMock).not.toHaveBeenCalled();
    expect(voidReservationMock).not.toHaveBeenCalled();
  });

  it('fails closed when the credits service is unreachable: sendFn never runs', async () => {
    const unavailableError = new AppError('CREDITS_SERVICE_UNAVAILABLE', {
      userMessage: 'Credits service is down.',
      statusCode: 503,
    });
    reserveCreditsMock.mockRejectedValue(unavailableError);

    const sendFn = vi.fn().mockResolvedValue('sent');

    await expect(meterDocumentSend({ userId: 42, envelopeId: 'envelope_abc' }, sendFn)).rejects.toBe(unavailableError);

    expect(sendFn).not.toHaveBeenCalled();
  });

  it('voids the reservation when sendFn throws, then rethrows the original error', async () => {
    reserveCreditsMock.mockResolvedValue({ reservationId: 'res_1', reserved: 500 });
    voidReservationMock.mockResolvedValue({ voided: true, reservationId: 'res_1' });

    const sendError = new Error('send failed: recipient email bounced');
    const sendFn = vi.fn().mockRejectedValue(sendError);

    await expect(meterDocumentSend({ userId: 42, envelopeId: 'envelope_abc' }, sendFn)).rejects.toBe(sendError);

    expect(voidReservationMock).toHaveBeenCalledWith('res_1');
    expect(commitReservationMock).not.toHaveBeenCalled();
  });

  it('does not mask the original send error when voiding the reservation also fails', async () => {
    reserveCreditsMock.mockResolvedValue({ reservationId: 'res_1', reserved: 500 });
    voidReservationMock.mockRejectedValue(new Error('void also failed'));

    const sendError = new Error('send failed');
    const sendFn = vi.fn().mockRejectedValue(sendError);

    await expect(meterDocumentSend({ userId: 42, envelopeId: 'envelope_abc' }, sendFn)).rejects.toBe(sendError);
  });

  it('does not fail the send when commit fails after a successful send (logged, not thrown)', async () => {
    reserveCreditsMock.mockResolvedValue({ reservationId: 'res_1', reserved: 500 });
    commitReservationMock.mockRejectedValue(new Error('commit failed'));

    const result = await meterDocumentSend({ userId: 42, envelopeId: 'envelope_abc' }, async () => 'sent');

    expect(result).toBe('sent');
  });
});
