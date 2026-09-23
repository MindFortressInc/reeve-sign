import type { Locator } from '@playwright/test';

export type OnScreenBox = { x: number; y: number; width: number; height: number };

/**
 * Full on-screen containment: x/y AND right/bottom against the viewport.
 * Half of "no off-screen field interactions" is trivial (nothing renders at
 * negative coordinates); the half that actually catches overflow is the
 * bottom/right edge, which a narrow mobile viewport is exactly where a fixed
 * desktop-sized control would clip.
 */
export const assertFullyOnScreen = (box: OnScreenBox, viewport: { width: number; height: number }, label: string) => {
  const withinX = box.x >= 0 && box.x + box.width <= viewport.width + 1;
  const withinY = box.y >= 0 && box.y + box.height <= viewport.height + 1;

  if (!withinX || !withinY) {
    throw new Error(`${label} is not fully on-screen: box=${JSON.stringify(box)} viewport=${JSON.stringify(viewport)}`);
  }
};

/**
 * Drags a multi-point zig-zag stroke across the signature canvas, well
 * inside its bounds. Uses `page.mouse`, which Playwright dispatches as
 * Pointer Events in both Chromium and WebKit -- exactly what
 * `signature-pad-draw.tsx`'s onPointerDown/Move/Up handlers consume
 * (`touchAction: 'none'`). It does NOT dispatch native `touchstart`/
 * `touchmove` events or exercise a `pointerType: 'touch'` code path:
 * Playwright has no cross-browser API for that (CDP touch dispatch is
 * Chromium-only), so this proves the pointer gesture completes a valid
 * signature under a mobile viewport/DPR/hasTouch device profile, not literal
 * touch-event dispatch or physical finger/stylus contact -- that hardware
 * distinction is DEV-12027's remit.
 */
export const dragSignatureStroke = async (canvas: Locator) => {
  const box = await canvas.boundingBox();

  if (!box) {
    throw new Error('signature-pad-draw canvas has no bounding box (off-screen or not rendered)');
  }

  const page = canvas.page();
  const marginX = box.width * 0.15;
  const marginY = box.height * 0.3;
  const left = box.x + marginX;
  const right = box.x + box.width - marginX;
  const top = box.y + marginY;
  const bottom = box.y + box.height - marginY;
  const mid = box.y + box.height / 2;

  const path = [
    { x: left, y: mid },
    { x: left + (right - left) * 0.2, y: top },
    { x: left + (right - left) * 0.4, y: bottom },
    { x: left + (right - left) * 0.6, y: top },
    { x: left + (right - left) * 0.8, y: bottom },
    { x: right, y: mid },
  ];

  await page.mouse.move(path[0].x, path[0].y);
  await page.mouse.down();

  for (const point of path.slice(1)) {
    await page.mouse.move(point.x, point.y, { steps: 8 });
  }

  await page.mouse.up();

  return box;
};
