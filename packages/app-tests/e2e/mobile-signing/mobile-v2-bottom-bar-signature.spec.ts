import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

/**
 * DEV-20648: on a V2 envelope (what Reeve's /api/v2 sends create), a signature
 * adopted in the mobile bottom "Sign Document" bar must sign the document. It
 * used to only save a default for a later field tap, so the fields stayed
 * unsigned and the button stayed "Next Field".
 */
test.describe('[DEV-20648] Mobile bottom bar signs a V2 envelope', () => {
  test('a signature adopted in the bottom bar fills every signature field', async ({ page }) => {
    const { user, team } = await seedUser({ isPersonalOrganisation: true });

    const { document, recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      recipients: [`mobile-v2-signer-${Date.now()}@test.documenso.com`],
      recipientsCreateOptions: [{ name: 'Mobile Signer' }],
      fields: [FieldType.SIGNATURE, FieldType.SIGNATURE],
      updateDocumentOptions: { internalVersion: 2 },
      teamId: team.id,
    });

    const { token } = recipients[0];

    await page.goto(`/sign/${token}`);

    const expand = page.getByRole('button', { name: 'Expand', exact: true });
    await expect(expand).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('2 Fields Remaining').filter({ visible: true })).toBeVisible();

    await expand.click();
    // The desktop sidebar is in the DOM too, hidden by CSS.
    await page.getByTestId('signature-pad-dialog-button').filter({ visible: true }).click();
    await page.getByRole('tab', { name: 'Type' }).click();
    await page.getByTestId('signature-pad-type-input').fill('Mobile Signer');
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    const complete = page.getByRole('button', { name: 'Complete', exact: true }).filter({ visible: true });
    await expect(complete).toBeVisible({ timeout: 15_000 });

    const fields = await prisma.field.findMany({ where: { envelopeId: document.id } });
    expect(fields).toHaveLength(2);
    expect(fields.every((field) => field.inserted)).toBe(true);

    await complete.click();
    await page.getByRole('button', { name: 'Sign', exact: true }).click();

    await page.waitForURL(`/sign/${token}/complete`);
    await expect(page.getByText('Document Signed')).toBeVisible();
  });
});
