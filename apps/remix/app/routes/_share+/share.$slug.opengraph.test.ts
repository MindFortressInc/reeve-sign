import type { ReactElement, ReactNode } from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-15841: the share-card heading must read "Document Signed!" for a
// recipient. `isRecipient` used to test `'Signature' in recipientOrSender`,
// but getRecipientOrSenderByShareLinkSlug's recipient shape carries
// `signatures` (lowercase plural), so every card said "Document Sent!".
//
// satori is mocked to capture the element tree the loader renders, so the
// assertion is on the real heading the loader builds, not a re-derivation.
const getRecipientOrSenderMock = vi.fn();
const satoriMock = vi.fn().mockResolvedValue('<svg />');

vi.mock('@documenso/lib/server-only/document/get-recipient-or-sender-by-share-link-slug', () => ({
  getRecipientOrSenderByShareLinkSlug: getRecipientOrSenderMock,
}));

vi.mock('@documenso/lib/constants/app', () => ({
  NEXT_PUBLIC_WEBAPP_URL: () => 'http://localhost:3000',
}));

vi.mock('@documenso/lib/utils/images/svg-to-png', () => ({
  svgToPng: vi.fn().mockResolvedValue(Buffer.from('png')),
}));

vi.mock('satori', () => ({ default: satoriMock }));

const findHeadingText = (node: ReactNode): string | null => {
  if (!node || typeof node !== 'object' || !('props' in node)) {
    return null;
  }

  const element = node as ReactElement<{ children?: ReactNode }>;

  if (element.type === 'h2') {
    return String(element.props.children);
  }

  const children = Array.isArray(element.props.children) ? element.props.children : [element.props.children];

  for (const child of children) {
    const text = findHeadingText(child as ReactNode);

    if (text) {
      return text;
    }
  }

  return null;
};

const renderHeading = async (recipientOrSender: unknown) => {
  getRecipientOrSenderMock.mockResolvedValue(recipientOrSender);

  const { loader } = await import('./share.$slug.opengraph');

  const response = await loader({ params: { slug: 'abc123' } } as Parameters<typeof loader>[0]);

  expect(response.status).toBe(200);

  return findHeadingText(satoriMock.mock.calls[0][0] as ReactNode);
};

describe('share.$slug.opengraph loader heading', () => {
  beforeEach(() => {
    satoriMock.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ArrayBuffer(8))),
    );
  });

  it('says "Document Signed!" for a recipient share link', async () => {
    const heading = await renderHeading({
      email: 'signer@example.com',
      name: 'Signer',
      signatures: [],
    });

    expect(heading).toBe('Document Signed!');
  });

  it('says "Document Sent!" for a sender share link', async () => {
    const heading = await renderHeading({
      email: 'sender@example.com',
      name: 'Sender',
      signature: null,
    });

    expect(heading).toBe('Document Sent!');
  });

  // DEV-15850: an unknown/deleted slug used to throw out of the loader (500)
  // because the helper threw while the loader guarded a dead `'error' in` shape.
  it('returns 404 for an unknown share slug without rendering', async () => {
    getRecipientOrSenderMock.mockResolvedValue(null);

    const { loader } = await import('./share.$slug.opengraph');

    const response = await loader({ params: { slug: 'missing' } } as Parameters<typeof loader>[0]);

    expect(response.status).toBe(404);
    expect(satoriMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
