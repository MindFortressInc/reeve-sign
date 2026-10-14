import { prisma } from '@documenso/prisma';
import { seedCompletedDocument, seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, type Page, test } from '@playwright/test';
import { FieldType } from '@prisma/client';
import { nanoid } from 'nanoid';

import { apiSignin } from '../fixtures/authentication';

/**
 * DEV-15772: a completed signing link is forwarded around. Only the browser that
 * signed (signer-proof cookie) or a session logged in as the recipient sees the
 * full completion page; everyone else gets the redacted "Sign in to Reeve to
 * view" state with no recipient PII, never a redirect off the page.
 */

const expectRedacted = async (page: Page, token: string, recipientEmail: string) => {
  await expect(page).toHaveURL(new RegExp(`/sign/${token}/complete$`));
  await expect(page.getByTestId('document-redacted-preview')).toBeVisible();
  await expect(page.getByText('Sign in to Reeve to view')).toBeVisible();
  await expect(page.getByText('Document Signed')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);

  const html = await page.content();

  expect(html).not.toContain(recipientEmail);
};

test('[COMPLETED_LINK_PRIVACY]: the signer keeps the full page; a forwarded link is redacted', async ({
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

  // Re-opening the link in the signing browser still shows the full page.
  await page.goto(`/sign/${token}`);
  await page.waitForURL(`/sign/${token}/complete`);
  await expect(page.getByText('Document Signed')).toBeVisible();

  // Anyone the link is forwarded to (fresh browser, no cookie, no session).
  const forwardedContext = await browser.newContext();
  const forwardedPage = await forwardedContext.newPage();

  await forwardedPage.goto(`/sign/${token}`);
  await expectRedacted(forwardedPage, token, recipientEmail);
  await expect(forwardedPage.getByRole('link', { name: 'Sign in to Reeve to view' })).toHaveAttribute(
    'href',
    `/signin?returnTo=${encodeURIComponent(`/sign/${token}/complete`)}`,
  );

  await forwardedContext.close();
});

test('[COMPLETED_LINK_PRIVACY]: a logged-in non-recipient is redacted, not redirected', async ({ page }) => {
  const { user: sender, team } = await seedUser();
  const { user: otherUser } = await seedUser();
  const recipientEmail = `signer-${nanoid(8)}@example.com`.toLowerCase();

  const document = await seedCompletedDocument(sender, team.id, [recipientEmail]);
  const { token } = await getRecipientToken(document.id);

  await apiSignin({ page, email: otherUser.email, redirectPath: `/sign/${token}` });

  await expectRedacted(page, token, recipientEmail);
  await expect(page.getByRole('button', { name: 'Sign in to Reeve to view' })).toBeVisible();
});

test('[COMPLETED_LINK_PRIVACY]: a session logged in as the recipient sees the full page', async ({ page }) => {
  const { user: sender, team } = await seedUser();
  const { user: recipientUser } = await seedUser();

  const document = await seedCompletedDocument(sender, team.id, [recipientUser]);
  const { token } = await getRecipientToken(document.id);

  await apiSignin({ page, email: recipientUser.email, redirectPath: `/sign/${token}` });

  await page.waitForURL(`/sign/${token}/complete`);
  await expect(page.getByText('Document Signed')).toBeVisible();
  await expect(page.getByTestId('document-redacted-preview')).toHaveCount(0);
});

test('[COMPLETED_LINK_PRIVACY]: a share link shows the private state to humans instead of the marketing site', async ({
  page,
}) => {
  await page.goto('/share/not-a-real-share-slug');

  await expect(page).toHaveURL(/\/share\/not-a-real-share-slug$/);
  await expect(page.getByTestId('document-redacted-preview')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to Reeve to view' })).toHaveAttribute('href', '/signin');
});

const getRecipientToken = async (envelopeId: string) =>
  prisma.recipient.findFirstOrThrow({ where: { envelopeId }, select: { token: true } });
