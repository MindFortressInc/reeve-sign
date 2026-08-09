import { expect, type Page, test } from '@playwright/test';

import { clickAddMyselfButton, openDocumentEnvelopeEditor } from '../fixtures/envelope-editor';
import { getKonvaElementCountForPage } from '../fixtures/konva';

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

/**
 * The 10 field types rendered by the field palette, in `fieldButtonList` order.
 */
const FIELD_PALETTE_TYPES = [
  'SIGNATURE',
  'EMAIL',
  'NAME',
  'INITIALS',
  'DATE',
  'TEXT',
  'NUMBER',
  'RADIO',
  'CHECKBOX',
  'DROPDOWN',
] as const;

/**
 * The minimum touch target size for the mobile palette buttons.
 */
const MINIMUM_TOUCH_TARGET_PX = 44;

const getEditorContentPane = (root: Page) => root.locator('[data-testid="envelope-editor-content"]');

const getMobileStepNavTrigger = (root: Page) => root.locator('[data-testid="envelope-editor-mobile-step-nav-trigger"]');

const clickMobileEnvelopeEditorStep = async (root: Page, stepId: 'upload' | 'addFields' | 'preview') => {
  await getMobileStepNavTrigger(root).click();
  await root.locator(`[data-testid="envelope-editor-mobile-step-${stepId}"]`).click();
};

const expectUsableContentPane = async (root: Page, minimumPaneWidth: number) => {
  const contentPane = getEditorContentPane(root);

  await expect(contentPane).toBeVisible();

  const boundingBox = await contentPane.boundingBox();

  expect(boundingBox).not.toBeNull();
  expect(boundingBox!.width).toBeGreaterThanOrEqual(minimumPaneWidth);
};

const expectNoHorizontalPageScroll = async (root: Page, viewportWidth: number) => {
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
    await expectUsableContentPane(page, MINIMUM_USABLE_PANE_WIDTH);
    await expectNoHorizontalPageScroll(page, MOBILE_VIEWPORT.width);

    // Add Fields step: the canvas keeps usable width and the PDF renders.
    await clickMobileEnvelopeEditorStep(page, 'addFields');
    await expect(page.locator('.react-pdf__Page').first()).toBeVisible();
    await expectUsableContentPane(page, MINIMUM_USABLE_PANE_WIDTH);
    await expectNoHorizontalPageScroll(page, MOBILE_VIEWPORT.width);

    // Preview step: the canvas keeps usable width and the PDF renders.
    await clickMobileEnvelopeEditorStep(page, 'preview');
    await expect(page.locator('.react-pdf__Page').first()).toBeVisible();
    await expectUsableContentPane(page, MINIMUM_USABLE_PANE_WIDTH);
    await expectNoHorizontalPageScroll(page, MOBILE_VIEWPORT.width);

    // Navigate back to the upload step through the drawer.
    await clickMobileEnvelopeEditorStep(page, 'upload');
    await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
  });

  test('mobile reaches the fields control panel that is a sidebar at lg', async ({ page }) => {
    await openDocumentEnvelopeEditor(page);

    await page.setViewportSize(MOBILE_VIEWPORT);

    // The panel only exists once the envelope has a recipient to place fields for.
    await clickAddMyselfButton(page);

    await clickMobileEnvelopeEditorStep(page, 'addFields');
    await expect(page.locator('.react-pdf__Page').first()).toBeVisible();

    // The regression this covers: below lg the control panel was `hidden` with no
    // replacement, so the recipient selector, the field palette and the per-field
    // settings forms were unreachable — the step was navigable but not usable.
    await expect(page.getByRole('heading', { name: 'Selected Recipient' })).toBeHidden();

    const panelTrigger = page.locator('[data-testid="envelope-editor-mobile-fields-panel-trigger"]');

    await expect(panelTrigger).toBeVisible();
    await panelTrigger.click();

    // Scope to the sheet so these locators name the surface under test and stay
    // unambiguous under strict mode even if the lg sidebar is ever changed to
    // mount below lg as well. Today it is not: the two render sites are
    // mutually exclusive on `isBelowLg`.
    const panel = page.getByRole('dialog');

    await expect(panel.getByRole('heading', { name: 'Selected Recipient' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Add Fields' })).toBeVisible();

    const signatureFieldButton = panel.getByRole('button', { name: 'Signature' });

    await expect(signatureFieldButton).toBeVisible();

    // Placement is completed by clicking the document, so arming a field type has
    // to dismiss the sheet — otherwise it covers the page the user must click.
    await signatureFieldButton.click();
    await expect(panel).toBeHidden();

    // …and the armed field must SURVIVE that dismissal. Asserting the sheet
    // closes is not enough: while the armed type lived inside the sheet, closing
    // it disarmed placement, so mobile could arm a field and never place one.
    const canvas = page.locator('.konva-container canvas').first();

    await expect(canvas).toBeVisible();
    await canvas.click({ position: { x: 120, y: 140 } });

    expect(await getKonvaElementCountForPage(page, 1, '.field-group')).toBe(1);

    await expectNoHorizontalPageScroll(page, MOBILE_VIEWPORT.width);
  });

  test('mobile field palette keeps all 10 field types reachable at 393x852', async ({ page }) => {
    const surface = await openDocumentEnvelopeEditor(page);

    // A recipient is required for the field palette to render.
    await clickAddMyselfButton(surface.root);

    await page.setViewportSize(MOBILE_VIEWPORT);

    await clickMobileEnvelopeEditorStep(page, 'addFields');
    await expect(page.locator('.react-pdf__Page').first()).toBeVisible();

    // The recipient selector must be reachable outside of the hidden desktop panel.
    await expect(page.locator('[data-testid="envelope-editor-mobile-recipient-selector"]')).toBeVisible();

    const palette = page.locator('[data-testid="envelope-editor-mobile-field-palette"]');

    await expect(palette).toBeVisible();
    await expect(palette.locator('[data-testid^="field-palette-button-"]')).toHaveCount(
      FIELD_PALETTE_TYPES.length,
    );

    for (const fieldType of FIELD_PALETTE_TYPES) {
      const button = palette.locator(`[data-testid="field-palette-button-${fieldType}"]`);

      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeVisible();

      const boundingBox = await button.boundingBox();

      expect(boundingBox).not.toBeNull();

      // Once scrolled into view, the button must sit fully within the viewport width.
      expect(boundingBox!.x).toBeGreaterThanOrEqual(0);
      expect(boundingBox!.x + boundingBox!.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);

      // The button must be a usable touch target.
      expect(boundingBox!.width).toBeGreaterThanOrEqual(MINIMUM_TOUCH_TARGET_PX);
      expect(boundingBox!.height).toBeGreaterThanOrEqual(MINIMUM_TOUCH_TARGET_PX);
    }
  });

  test('mobile shell keeps the document canvas usable at 320px', async ({ page }) => {
    await openDocumentEnvelopeEditor(page);

    await page.setViewportSize(SMALL_MOBILE_VIEWPORT);

    // Note: the whole-page no-horizontal-scroll assertion is intentionally not made
    // at 320px. The header actions (attachments / send) still overflow at this width
    // and collapse into a compact menu with DEV-8187, which carries that assertion.
    await expect(getMobileStepNavTrigger(page)).toBeVisible();
    await expectUsableContentPane(page, 300);

    await clickMobileEnvelopeEditorStep(page, 'addFields');
    await expect(page.locator('.react-pdf__Page').first()).toBeVisible();
    await expectUsableContentPane(page, 300);
  });
});
