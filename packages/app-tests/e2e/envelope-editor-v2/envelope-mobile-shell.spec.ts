import { expect, type Page, test } from '@playwright/test';

import { openDocumentEnvelopeEditor } from '../fixtures/envelope-editor';

test.use({
  storageState: {
    cookies: [],
    origins: [],
  },
});

const MOBILE_VIEWPORT = { width: 393, height: 852 };
const SMALL_MOBILE_VIEWPORT = { width: 320, height: 700 };

/**
 * The minimum usable width of the document canvas pane at the 393px mobile viewport.
 *
 * Prior to the responsive shell, the in-flow 320px step sidebar left only a 73px
 * canvas at 393px, which broke PDF rendering on the Add Fields step.
 */
const MINIMUM_USABLE_PANE_WIDTH = 340;

const getEditorContentPane = (root: Page) => root.locator('[data-testid="envelope-editor-content"]');

const getMobileStepNavTrigger = (root: Page) => root.locator('[data-testid="envelope-editor-mobile-step-nav-trigger"]');

const clickMobileEnvelopeEditorStep = async (root: Page, stepId: 'upload' | 'addFields' | 'preview') => {
  await getMobileStepNavTrigger(root).click();
  await root.locator(`[data-testid="envelope-editor-mobile-step-${stepId}"]`).click();
};

const expectUsableContentPane = async (root: Page, minimumPaneWidth: number, viewportWidth: number) => {
  const contentPane = getEditorContentPane(root);

  await expect(contentPane).toBeVisible();

  const boundingBox = await contentPane.boundingBox();

  expect(boundingBox).not.toBeNull();
  expect(boundingBox!.width).toBeGreaterThanOrEqual(minimumPaneWidth);

  // No horizontal scroll.
  const scrollWidth = await root.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(viewportWidth);
};

test.describe('document editor', () => {
  test('mobile shell keeps the document canvas usable at 393x852', async ({ page }) => {
    await openDocumentEnvelopeEditor(page);

    await page.setViewportSize(MOBILE_VIEWPORT);

    // The desktop step sidebar must be out of flow below lg, replaced by the drawer trigger.
    await expect(page.locator('[data-testid="envelope-editor-step-upload"]')).toBeHidden();
    await expect(getMobileStepNavTrigger(page)).toBeVisible();

    // Upload step canvas is full width.
    await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
    await expectUsableContentPane(page, MINIMUM_USABLE_PANE_WIDTH, MOBILE_VIEWPORT.width);

    // Add Fields step: the canvas keeps usable width and the PDF renders.
    await clickMobileEnvelopeEditorStep(page, 'addFields');
    await expect(page.locator('.react-pdf__Page').first()).toBeVisible();
    await expectUsableContentPane(page, MINIMUM_USABLE_PANE_WIDTH, MOBILE_VIEWPORT.width);

    // Preview step: the canvas keeps usable width and the PDF renders.
    await clickMobileEnvelopeEditorStep(page, 'preview');
    await expect(page.locator('.react-pdf__Page').first()).toBeVisible();
    await expectUsableContentPane(page, MINIMUM_USABLE_PANE_WIDTH, MOBILE_VIEWPORT.width);

    // Navigate back to the upload step through the drawer.
    await clickMobileEnvelopeEditorStep(page, 'upload');
    await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
  });

  test('mobile shell has no horizontal scroll at 320px', async ({ page }) => {
    await openDocumentEnvelopeEditor(page);

    await page.setViewportSize(SMALL_MOBILE_VIEWPORT);

    await expect(getMobileStepNavTrigger(page)).toBeVisible();
    await expectUsableContentPane(page, 300, SMALL_MOBILE_VIEWPORT.width);

    await clickMobileEnvelopeEditorStep(page, 'addFields');
    await expect(page.locator('.react-pdf__Page').first()).toBeVisible();
    await expectUsableContentPane(page, 300, SMALL_MOBILE_VIEWPORT.width);
  });
});
