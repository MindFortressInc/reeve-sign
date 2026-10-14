import { prisma } from '@documenso/prisma';
import { seedCompletedDocument, seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { FieldType, type User } from '@prisma/client';
import { nanoid } from 'nanoid';

import { apiSignin } from '../fixtures/authentication';

/**
 * DEV-15772: a completed signing link gets forwarded. For 7 days after the
 * envelope completes, anyone holding it sees the completed page and can
 * download. After that only the owner's or the recipient's session can;
 * everyone else gets "This link has expired" with no recipient PII, and the
 * token PDF endpoints return 404.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const seedExpiredCompletedDocument = async (recipient: User | string) => {
  const { user: sender, team } = await seedUser();
  const title = `Mutual NDA ${nanoid(6)}`;

  const document = await seedCompletedDocument(sender, team.id, [recipient]);

  await prisma.envelope.update({
    where: { id: document.id },
    data: { title, completedAt: new Date(Date.now() - 8 * DAY_MS) },
  });

  const { token, email } = await prisma.recipient.findFirstOrThrow({
    where: { envelopeId: document.id },
    select: { token: true, email: true },
  });

  const item = await prisma.envelopeItem.findFirstOrThrow({
    where: { envelopeId: document.id },
    select: { id: true, documentDataId: true },
  });

  const itemsByTokenInput = encodeURIComponent(
    JSON.stringify({ json: { envelopeId: document.id, access: { type: 'recipient', token } } }),
  );

  const pdfUrls = [
    `/api/trpc/envelope.item.getManyByToken?input=${itemsByTokenInput}`,
    `/api/files/token/${token}/envelopeItem/${item.id}`,
    `/api/files/token/${token}/envelopeItem/${item.id}/download/signed`,
    `/api/files/token/${token}/envelope/${document.id}/envelopeItem/${item.id}/dataId/${item.documentDataId}/current/item.pdf`,
  ];

  return { sender, envelopeId: document.id, title, token, recipientEmail: email, pdfUrls };
};

const expectPdfStatuses = async (request: APIRequestContext, urls: string[], status: number) => {
  for (const url of urls) {
    const response = await request.get(url);

    expect(response.status(), url).toBe(status);
  }
};

const expectExpired = async (page: Page, token: string, pii: string[]) => {
  await expect(page).toHaveURL(new RegExp(`/sign/${token}/complete$`));
  await expect(page.getByTestId('completed-link-expired')).toBeVisible();
  await expect(page.getByText('This link has expired')).toBeVisible();
  await expect(page.getByText('Document Signed')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);

  const html = await page.content();

  for (const value of pii) {
    expect(html).not.toContain(value);
  }
};

test('[COMPLETED_LINK_PRIVACY]: within 7 days a forwarded link shows the full completed page', async ({
  page,
  browser,
}) => {
  const { user, team } = await seedUser();
  const recipientEmail = `signer-${nanoid(8)}@example.com`.toLowerCase();

  const { recipients } = await seedPendingDocumentWithFullFields({
    teamId: team.id,
    owner: user,
    recipients: [recipientEmail],
    fields: [FieldType.DATE],
  });

  const { token, fields } = recipients[0];

  await page.goto(`/sign/${token}`);
  await page.locator(`#field-${fields[0].id}`).getByRole('button').click();
  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByRole('dialog').getByText('Complete Signing').first()).toBeVisible();
  await page.getByRole('button', { name: 'Sign' }).click();

  await page.waitForURL(`/sign/${token}/complete`);
  await expect(page.getByText('Document Signed')).toBeVisible();

  // Anyone the link is forwarded to (fresh browser, no session).
  const forwardedContext = await browser.newContext();
  const forwardedPage = await forwardedContext.newPage();

  await forwardedPage.goto(`/sign/${token}`);
  await forwardedPage.waitForURL(`/sign/${token}/complete`);
  await expect(forwardedPage.getByText('Document Signed')).toBeVisible();
  await expect(forwardedPage.getByRole('button', { name: 'Download' })).toBeVisible();
  await expect(forwardedPage.getByTestId('completed-link-expired')).toHaveCount(0);

  await forwardedContext.close();
});

test('[COMPLETED_LINK_PRIVACY]: past 7 days a forwarded link is expired and the token PDF is 404', async ({ page }) => {
  const recipientEmail = `signer-${nanoid(8)}@example.com`.toLowerCase();
  const { token, title, pdfUrls } = await seedExpiredCompletedDocument(recipientEmail);

  await page.goto(`/sign/${token}`);

  await expectExpired(page, token, [recipientEmail, title]);
  await expect(page.getByRole('link', { name: 'Sign in to Reeve to view' })).toHaveAttribute(
    'href',
    `/signin?returnTo=${encodeURIComponent(`/sign/${token}/complete`)}`,
  );

  await expectPdfStatuses(page.request, pdfUrls, 404);
});

test('[COMPLETED_LINK_PRIVACY]: past 7 days a logged-in stranger is expired, not redirected', async ({ page }) => {
  const { user: otherUser } = await seedUser();
  const recipientEmail = `signer-${nanoid(8)}@example.com`.toLowerCase();
  const { token, title, pdfUrls } = await seedExpiredCompletedDocument(recipientEmail);

  await apiSignin({ page, email: otherUser.email, redirectPath: `/sign/${token}` });

  await expectExpired(page, token, [recipientEmail, title]);
  await expect(page.getByRole('button', { name: 'Sign in to Reeve to view' })).toBeVisible();

  await expectPdfStatuses(page.request, pdfUrls, 404);
});

test('[COMPLETED_LINK_PRIVACY]: past 7 days the recipient session still sees the full page and PDF', async ({
  page,
}) => {
  const { user: recipientUser } = await seedUser();
  const { token, pdfUrls } = await seedExpiredCompletedDocument(recipientUser);

  await apiSignin({ page, email: recipientUser.email, redirectPath: `/sign/${token}` });

  await page.waitForURL(`/sign/${token}/complete`);
  await expect(page.getByText('Document Signed')).toBeVisible();
  await expect(page.getByTestId('completed-link-expired')).toHaveCount(0);

  await expectPdfStatuses(page.request, pdfUrls, 200);
});

test('[COMPLETED_LINK_PRIVACY]: past 7 days the owner session still sees the full page', async ({ page }) => {
  const recipientEmail = `signer-${nanoid(8)}@example.com`.toLowerCase();
  const { sender, token, pdfUrls } = await seedExpiredCompletedDocument(recipientEmail);

  await apiSignin({ page, email: sender.email, redirectPath: `/sign/${token}` });

  await page.waitForURL(`/sign/${token}/complete`);
  await expect(page.getByText('Document Signed')).toBeVisible();

  await expectPdfStatuses(page.request, pdfUrls, 200);
});

test('[COMPLETED_LINK_PRIVACY]: a share link follows the same 7-day rule and never leaves the site', async ({
  page,
}) => {
  const recipientEmail = `signer-${nanoid(8)}@example.com`.toLowerCase();
  const { envelopeId, title } = await seedExpiredCompletedDocument(recipientEmail);
  const slug = `share${nanoid(10)}`;

  await prisma.documentShareLink.create({ data: { slug, email: recipientEmail, envelopeId } });

  // Within 7 days: a generic card, nothing about the recipient or the document.
  await prisma.envelope.update({ where: { id: envelopeId }, data: { completedAt: new Date() } });

  await page.goto(`/share/${slug}`);
  await expect(page).toHaveURL(new RegExp(`/share/${slug}$`));
  await expect(page.getByTestId('share-card')).toBeVisible();
  await expect(page.getByText('Document Signed')).toBeVisible();

  let html = await page.content();
  expect(html).not.toContain(recipientEmail);
  expect(html).not.toContain(title);

  // Past 7 days: expired.
  await prisma.envelope.update({
    where: { id: envelopeId },
    data: { completedAt: new Date(Date.now() - 8 * DAY_MS) },
  });

  await page.goto(`/share/${slug}`);
  await expect(page).toHaveURL(new RegExp(`/share/${slug}$`));
  await expect(page.getByTestId('completed-link-expired')).toBeVisible();

  html = await page.content();
  expect(html).not.toContain(recipientEmail);
  expect(html).not.toContain(title);

  // Unknown slug: 404, not the marketing site.
  const response = await page.goto('/share/not-a-real-share-slug');
  expect(response?.status()).toBe(404);
  await expect(page).toHaveURL(/\/share\/not-a-real-share-slug$/);
});
