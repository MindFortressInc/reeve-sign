import { expect, type Page, test } from '@playwright/test';

import { clickAddMyselfButton, clickEnvelopeEditorStep, openDocumentEnvelopeEditor } from '../fixtures/envelope-editor';
import { getKonvaElementCountForPage } from '../fixtures/konva';

test.use({
  storageState: {
    cookies: [],
    origins: [],
  },
  hasTouch: true,
});

const MOBILE_VIEWPORT = { width: 393, height: 852 };

const getMobileStepNavTrigger = (root: Page) => root.locator('[data-testid="envelope-editor-mobile-step-nav-trigger"]');

const clickMobileEnvelopeEditorStep = async (root: Page, stepId: 'upload' | 'addFields' | 'preview') => {
  await getMobileStepNavTrigger(root).click();
  await root.locator(`[data-testid="envelope-editor-mobile-step-${stepId}"]`).click();
};

const getFieldCountForFirstPage = async (root: Page) => getKonvaElementCountForPage(root, 1, '.field-group');

test.describe('document editor', () => {
  test('touch tap on an armed field type places a field at 393x852', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);

    // A recipient is required for the field palette to render.
    await clickAddMyselfButton(surface.root);

    await page.setViewportSize(MOBILE_VIEWPORT);

    await clickMobileEnvelopeEditorStep(page, 'addFields');

    const canvas = page.locator('.konva-container canvas').first();
    await expect(canvas).toBeVisible();

    const fieldsBefore = await getFieldCountForFirstPage(page);
    expect(fieldsBefore).toBe(0);

    // Arm the Signature field type from the mobile toolbar with a touch tap.
    const signatureButton = page.locator(
      '[data-testid="envelope-editor-mobile-field-palette"] [data-testid="field-palette-button-SIGNATURE"]',
    );

    await signatureButton.scrollIntoViewIfNeeded();
    await expect(signatureButton).toBeVisible();
    await signatureButton.tap();

    // Tap the document page. No pointermove ever fires for a tap, so this
    // asserts that placement works purely from the pointerup coordinates.
    await canvas.tap({ position: { x: 150, y: 150 } });

    // Exactly one — the page started empty and a single tap must not place twice,
    // which is the duplicate-placement regression this spec exists to catch.
    await expect.poll(async () => await getFieldCountForFirstPage(page)).toBe(1);
  });

  test('desktop mouse click placement still places a field', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);

    await clickAddMyselfButton(surface.root);

    await clickEnvelopeEditorStep(page, 'addFields');

    const canvas = page.locator('.konva-container canvas').first();
    await expect(canvas).toBeVisible();

    const fieldsBefore = await getFieldCountForFirstPage(page);
    expect(fieldsBefore).toBe(0);

    // Arm the Signature field type from the desktop palette with a mouse click.
    await page
      .locator('[data-testid="envelope-editor-field-palette"] [data-testid="field-palette-button-SIGNATURE"]')
      .click();

    await canvas.click({ position: { x: 150, y: 150 } });

    await expect.poll(async () => await getFieldCountForFirstPage(page)).toBe(1);
  });
});
