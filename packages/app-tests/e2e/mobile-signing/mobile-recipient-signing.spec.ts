import fs from 'node:fs';
import path from 'node:path';

import { getDocumentByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';
import { DocumentStatus, FieldType } from '@prisma/client';

import { assertFullyOnScreen, dragSignatureStroke } from '../fixtures/mobile-signature';

/**
 * DEV-659 -- Reeve.Sign mobile-first signing UX validation.
 *
 * `seedPendingDocumentWithFullFields` -> `seedBlankDocument` ->
 * `createEnvelope` defaults `internalVersion` to 1 (packages/prisma/seed/
 * documents.ts:534), so this is the same envelope shape a real freshly-sent
 * Reeve.Sign document has today, rendered by `document-signing-page-view-
 * v1.tsx`. That is a DIFFERENT component from `document-signing-page-view-
 * v2.tsx` / `document-signing-mobile-widget.tsx` (the V2/envelope-signer
 * surface, internalVersion 2, not exercised here) -- an earlier draft of
 * this spec conflated the two after reading V2 source while actually
 * driving V1 at runtime. V2 mobile coverage is a separate, not-yet-built
 * follow-up (see the ticket's follow-up notes).
 *
 * V1's mobile layout (document-signing-page-view-v1.tsx:290-379) is a fixed
 * bottom widget (`group/document-widget`) that starts COLLAPSED below the
 * `md` (768px) breakpoint (`useState(false)` at line 84) and, once expanded,
 * covers the on-page PDF field overlays with a `position: fixed` panel --
 * confirmed via Playwright's own actionability check refusing a plain click
 * on `#field-{id}` with "intercepts pointer events" while the panel is open.
 * So the real mobile flow is:
 *   1. Expand the panel (unlabelled chevron-up icon button -- both the
 *      expand AND collapse toggles carry no aria-label/accessible text in
 *      the rendered DOM, a real a11y gap; see the ticket's follow-up notes)
 *      to reach `DocumentSigningForm`'s Full Name + default-signature
 *      capture (packages/ui/primitives/signature-pad/signature-pad-dialog.tsx).
 *   2. Collapse the panel again (chevron-down) to uncover the actual PDF
 *      page and its field overlays.
 *   3. Tap each on-page field (`#field-{id}`, id set by
 *      packages/ui/components/field/field.tsx:114's FieldRootContainer) --
 *      `document-signing-signature-field.tsx`'s `onSign` reuses the
 *      already-captured default signature (`providedSignature`), so no
 *      second draw is needed; initials insert on a single tap; the text
 *      field opens its own small dialog (`#custom-text` + "Save").
 *   4. Once every required field is inserted, the widget's OWN header (still
 *      collapsed) shows a "Complete" trigger directly
 *      (document-signing-page-view-v1.tsx:306-329) -> opens the "Are you
 *      sure?" confirmation (document-signing-complete-dialog.tsx) -> "Sign"
 *      submits.
 *
 * This exercises 5 Playwright device-emulation profiles (see
 * playwright.config.ts) standing in for the ticket's "iPhone 12-15,
 * Pixel 7-8, iPad Mini, iPad Pro" acceptance criterion. Every
 * recipient/document here is a synthetic local fixture -- no real email, no
 * customer envelope.
 *
 * What this proves: a Buyer-Rep-shaped recipient opens a sent V1 envelope on
 * a mobile viewport, sets a real drag-gesture signature on-screen, expands
 * and collapses the mobile widget via ordinary taps, inserts
 * signature/initials/text fields via normal on-page taps, and completes the
 * envelope with a normal (non-forced) "Sign" tap -- timed from navigation to
 * confirmed COMPLETED status, under 120s.
 *
 * What this does NOT prove: native touch-event dispatch, physical
 * finger/stylus contact (DEV-12027's remit), or anything about the V2
 * envelope-signer surface (a separate, currently-unvalidated code path).
 */
const SCREENSHOT_DIR = path.join(__dirname, '../../test-results/dev-659-mobile-signing');
const COMPLETION_BUDGET_MS = 120_000;
const RECIPIENT_EMAIL = 'buyer-rep-mobile-e2e@example.com';
const RECIPIENT_NAME = 'Buyer Rep';

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

/**
 * One throwaway navigation, outside any timed test, so the dev server's
 * Vite JIT compile of the signing route graph (measured up to ~45s cold in
 * this repo) never counts against a profile's completion budget. A
 * production build has no such cost; this only exists because local
 * `npm run dev` compiles routes on demand.
 */
test.beforeEach(async ({ page, baseURL }, testInfo) => {
  const { user, team } = await seedUser({ isPersonalOrganisation: true });
  const { recipients } = await seedPendingDocumentWithFullFields({
    owner: user,
    recipients: ['warmup@example.com'],
    fields: [FieldType.SIGNATURE],
    teamId: team.id,
  });

  await page.goto(`${baseURL}/sign/${recipients[0].token}`);
  await page
    .getByTestId('signature-pad-dialog-button')
    .waitFor({ state: 'visible', timeout: 90_000 })
    .catch(() => {
      // Best-effort warm-up only -- the real test below asserts this for real.
    });

  testInfo.annotations.push({ type: 'warmup', description: 'dev-server route graph pre-compiled' });
});

test.describe('[DEV-659] Mobile recipient signing (V1 envelope, internalVersion=1)', () => {
  test('Buyer Rep recipient signs and completes a V1 envelope on a mobile profile', async ({ page }, testInfo) => {
    const profile = testInfo.project.name;
    const shot = (name: string) => path.join(SCREENSHOT_DIR, `${profile}-${name}.png`);

    const { user, team } = await seedUser({ isPersonalOrganisation: true });

    const { document, recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      recipients: [RECIPIENT_EMAIL],
      recipientsCreateOptions: [{ name: RECIPIENT_NAME }],
      fields: [FieldType.SIGNATURE, FieldType.INITIALS, FieldType.TEXT],
      teamId: team.id,
    });

    const recipient = recipients[0];

    // Full navigation-to-completion timing, per the ticket's "<2 min"
    // wording -- real user-facing load time, not just the final interaction.
    const startedAt = Date.now();

    await page.goto(`/sign/${recipient.token}`);
    await expect(page.getByText('has invited you to sign this document')).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: shot('01-loaded-collapsed'), fullPage: true });

    const viewport = page.viewportSize();

    // --- Step 1: expand the widget (only exists below the `md` 768px
    // breakpoint -- document-signing-page-view-v1.tsx's toggle buttons are
    // `md:hidden`; at md+ width the panel is an always-visible sidebar via
    // `md:block`, same as desktop, so iPad Mini (768px) and iPad Pro 11
    // (834px) skip this step entirely) and set the default signature.
    const chevronUp = page.locator('button:has(svg.lucide-chevron-up)').first();
    const isCollapsibleLayout = await chevronUp.isVisible().catch(() => false);

    if (isCollapsibleLayout) {
      await chevronUp.click();
    }

    await expect(page.getByTestId('signature-pad-dialog-button')).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: shot('02-widget-expanded'), fullPage: true });

    await page.getByTestId('signature-pad-dialog-button').click();
    const canvas = page.getByTestId('signature-pad-draw');
    await canvas.waitFor({ state: 'visible', timeout: 15_000 });
    const canvasBox = await dragSignatureStroke(canvas);

    if (viewport) {
      assertFullyOnScreen(canvasBox, viewport, 'signature-pad-draw canvas');
    }

    await page.screenshot({ path: shot('03-signature-drawn'), fullPage: true });

    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // --- Step 2: collapse the widget to uncover the on-page fields (mobile
    // layout only -- at md+ the sidebar never covers the page, matching the
    // desktop-only e2e/scenarios/reeve-sign-cutover-happy-path.spec.ts spec).
    if (isCollapsibleLayout) {
      await page.locator('button:has(svg.lucide-chevron-down)').first().click();
    }

    await page.screenshot({ path: shot('04-widget-collapsed'), fullPage: true });

    // --- Step 3: insert each on-page field with an ordinary tap ---
    for (const field of recipient.fields) {
      const fieldLocator = page.locator(`#field-${field.id}`);
      await expect(fieldLocator).toBeVisible({ timeout: 15_000 });

      const fieldBox = await fieldLocator.boundingBox();

      if (fieldBox && viewport) {
        assertFullyOnScreen(fieldBox, viewport, `#field-${field.id} (${field.type})`);
      }

      await fieldLocator.getByRole('button').click();

      if (field.type === FieldType.TEXT) {
        const textarea = page.locator('#custom-text');
        await textarea.waitFor({ state: 'visible', timeout: 10_000 });
        await textarea.fill('Approved via DEV-659 mobile E2E');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
      }

      await expect(fieldLocator).toHaveAttribute('data-inserted', 'true', { timeout: 15_000 });
    }

    await page.screenshot({ path: shot('05-fields-inserted'), fullPage: true });

    // --- Step 4: complete, via the widget's own collapsed-header trigger ---
    const completeBtn = page.getByRole('button', { name: 'Complete', exact: true });
    await expect(completeBtn).toBeVisible({ timeout: 15_000 });
    await expect(completeBtn).toBeEnabled();
    await completeBtn.click();

    const signBtn = page.getByRole('button', { name: 'Sign', exact: true });
    await expect(signBtn).toBeVisible({ timeout: 10_000 });

    const signBox = await signBtn.boundingBox();

    if (signBox && viewport) {
      assertFullyOnScreen(signBox, viewport, 'Sign confirmation button');
    }

    // No force: a real recipient cannot force a tap through an obscuring
    // element, so neither does this test -- a genuinely blocked control here
    // would be the finding, not something to paper over.
    await expect(signBtn).toBeEnabled();
    await signBtn.click();

    await page.waitForURL(`/sign/${recipient.token}/complete`, { timeout: 15_000 });

    await expect(async () => {
      const { status } = await getDocumentByToken({ token: recipient.token });

      expect(status).toBe(DocumentStatus.COMPLETED);
    }).toPass();

    const elapsedMs = Date.now() - startedAt;

    await page.screenshot({ path: shot('06-completed'), fullPage: true });

    await expect(async () => {
      const completionAuditLog = await prisma.documentAuditLog.findFirst({
        where: {
          envelopeId: document.id,
          type: 'DOCUMENT_COMPLETED',
        },
      });

      expect(completionAuditLog).not.toBeNull();
    }).toPass();

    // eslint-disable-next-line no-console
    console.log(
      `[DEV-659] profile=${profile} internalVersion=1 elapsedMs=${elapsedMs} budgetMs=${COMPLETION_BUDGET_MS}`,
    );

    expect(
      elapsedMs,
      `envelope completion took ${elapsedMs}ms, over the ${COMPLETION_BUDGET_MS}ms budget`,
    ).toBeLessThan(COMPLETION_BUDGET_MS);
  });
});
