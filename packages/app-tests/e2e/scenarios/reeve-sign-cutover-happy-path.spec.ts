import { getDocumentByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { getEnvelopeItemPdfUrl } from '@documenso/lib/utils/envelope-download';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { PDF } from '@libpdf/core';
import { expect, test } from '@playwright/test';
import { DocumentStatus, FieldType } from '@prisma/client';

import {
  clickAddMyselfButton,
  clickEnvelopeEditorStep,
  getRecipientEmailInputs,
  openDocumentEnvelopeEditor,
} from '../fixtures/envelope-editor';
import { expectToastTextToBeVisible } from '../fixtures/generic';
import { signSignaturePad } from '../fixtures/signature';

/**
 * DEV-2840 — Reeve.Sign P6 cutover E2E gate.
 *
 * Gates the launch of `sign.meetreeve.com` as the branded self-serve product on
 * a green pass of the core self-serve happy path, split into the two proven
 * halves the fork's Playwright harness can drive hermetically:
 *
 *   1. AUTHORING -> SEND: a signed-in sender uploads a document, adds a
 *      recipient, drag-drops a signature field, and sends it (envelope goes
 *      PENDING and is distributed).
 *   2. SIGN -> COMPLETE -> AUDIT-TRAIL PDF: the recipient opens the signing
 *      link, signs, and completes; the envelope reaches COMPLETED, a
 *      DOCUMENT_COMPLETED audit-log row is written, and the sealed PDF carries
 *      the appended audit-trail / signing-certificate page.
 *
 * The Reeve-integration legs of the ticket's happy path are env-gated OFF in
 * this hermetic harness (their `REEVE_*` env vars are unset): Auth0 SSO
 * ("Continue with Reeve"), the ToS/Privacy consent gate (DEV-2837), and the
 * 500cr/doc metering charge (DEV-2838). They are correctly no-op here and are
 * verified LIVE against reeve-services during the production cutover, per the
 * ticket's "metering (exactly 500cr) + consent (ledger row) verified live"
 * acceptance. This gate covers the product surface those seams wrap.
 */
test.describe('[DEV-2840] Reeve.Sign cutover happy path', () => {
  test('sender authors a document, adds a recipient, places a field, and sends', async ({ page }) => {
    // Signed-in sender in their (JIT-provisioned) workspace, on a fresh upload.
    const surface = await openDocumentEnvelopeEditor(page);

    // Recipients: add the current user as a signer via the UI.
    await clickAddMyselfButton(surface.root);
    await expect(getRecipientEmailInputs(surface.root).first()).toHaveValue(surface.userEmail);

    // Drag-drop fields: place a signature field on the PDF canvas.
    await clickEnvelopeEditorStep(surface.root, 'addFields');
    await expect(surface.root.getByText('Selected Recipient')).toBeVisible();

    const canvas = surface.root.locator('.konva-container canvas').first();
    await expect(canvas).toBeVisible();
    await surface.root.getByRole('button', { name: 'Signature', exact: true }).click();
    await canvas.click({ position: { x: 120, y: 140 } });
    await expect(surface.root.getByText('1 Field')).toBeVisible();

    // Send: distribute the envelope.
    await clickEnvelopeEditorStep(surface.root, 'upload');
    await page.locator('button[title="Send Envelope"]').click();
    await expect(page.getByRole('heading', { name: 'Send Document' })).toBeVisible();
    await page.getByRole('button', { name: 'Send' }).click();
    await expectToastTextToBeVisible(page, 'Envelope distributed');

    // The document is now out for signature.
    const distributed = await prisma.envelope.findUniqueOrThrow({
      where: { id: surface.envelopeId },
    });

    expect(distributed.status).toBe(DocumentStatus.PENDING);
  });

  test('recipient signs a sent document and the completed envelope carries an audit-trail PDF', async ({ page }) => {
    const { user, team } = await seedUser({
      isPersonalOrganisation: true,
    });

    const { document, recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      recipients: ['signer@example.com'],
      fields: [FieldType.SIGNATURE],
      teamId: team.id,
    });

    const recipient = recipients[0];

    // Baseline page count of the (as-yet unsigned) document.
    const originalPdf = await prisma.envelopeItem
      .findFirstOrThrow({ where: { envelopeId: document.id } })
      .then(async (envelopeItem) => {
        const url = getEnvelopeItemPdfUrl({
          type: 'download',
          envelopeItem,
          token: recipient.token,
          version: 'signed',
        });

        return fetch(url)
          .then(async (res) => await res.arrayBuffer())
          .then(async (buffer) => await PDF.load(new Uint8Array(buffer)));
      });

    // Recipient signs.
    await page.goto(`/sign/${recipient.token}`);
    await signSignaturePad(page);

    for (const field of recipient.fields) {
      await page.locator(`#field-${field.id}`).getByRole('button').click();
      await expect(page.locator(`#field-${field.id}`)).toHaveAttribute('data-inserted', 'true');
    }

    await page.getByRole('button', { name: 'Complete' }).click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Sign' }).click({ force: true });
    await page.waitForURL(`/sign/${recipient.token}/complete`);

    // Envelope completes (seal + certificate generation is async).
    await expect(async () => {
      const { status } = await getDocumentByToken({ token: recipient.token });

      expect(status).toBe(DocumentStatus.COMPLETED);
    }).toPass();

    // Audit trail: the completion is recorded in the append-only audit log.
    await expect(async () => {
      const completionAuditLog = await prisma.documentAuditLog.findFirst({
        where: {
          envelopeId: document.id,
          type: 'DOCUMENT_COMPLETED',
        },
      });

      expect(completionAuditLog).not.toBeNull();
    }).toPass();

    await page.waitForTimeout(2500);

    // Audit-trail PDF: the sealed document has the signing-certificate page appended.
    const completedDocument = await prisma.envelope.findFirstOrThrow({
      where: { id: document.id },
      include: { envelopeItems: { include: { documentData: true } } },
    });

    const signedPdfUrl = getEnvelopeItemPdfUrl({
      type: 'download',
      envelopeItem: completedDocument.envelopeItems[0],
      token: recipient.token,
      version: 'signed',
    });

    const signedPdf = await fetch(signedPdfUrl)
      .then(async (res) => await res.arrayBuffer())
      .then(async (buffer) => await PDF.load(new Uint8Array(buffer)));

    expect(signedPdf.getPageCount()).toBe(originalPdf.getPageCount() + 1); // document + certificate
  });
});
