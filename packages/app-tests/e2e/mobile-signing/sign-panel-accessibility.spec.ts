import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

test.use({ viewport: { width: 390, height: 664 } });

test('V1 mobile sign panel has named expand and collapse controls', async ({ page }) => {
  const { user, team } = await seedUser({ isPersonalOrganisation: true });
  const { recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    recipients: ['sign-panel-accessibility@example.com'],
    recipientsCreateOptions: [{ name: 'Mobile Signer' }],
    fields: [FieldType.SIGNATURE],
    teamId: team.id,
  });

  await page.goto(`/sign/${recipients[0].token}`);

  const expand = page.getByRole('button', { name: 'Expand sign panel', exact: true });
  const collapse = page.getByRole('button', { name: 'Collapse sign panel', exact: true });
  const signature = page.getByTestId('signature-pad-dialog-button');

  await expect(expand).toBeVisible();
  await expect(signature).toBeHidden();
  await expand.click();
  await expect(collapse).toBeVisible();
  await expect(signature).toBeVisible();
  await collapse.click();
  await expect(expand).toBeVisible();
  await expect(signature).toBeHidden();
});
