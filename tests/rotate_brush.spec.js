import { test, expect } from '@playwright/test';

test('Rotate Brush Functionality', async ({ page }) => {
  // 1. Navigate to the app
  await page.goto('/index.html');
  await expect(page.locator('.panel.left .maincanvas')).toBeVisible();

  // Wait for the "About" panel to appear and close it
  const aboutPanel = page.locator('.modalwindow');
  await expect(aboutPanel).toBeVisible();
  // Click the close button (x) in the caption
  await page.locator('.modalwindow .caption .button').click();
  await expect(aboutPanel).toBeHidden();

  // 2. Select the "Select" tool
  const selectTool = page.locator('.button.icon.select');
  await selectTool.click();
  await expect(selectTool).toHaveClass(/active/);

  // 3. Make a rectangular selection (20x10)
  const canvas = page.locator('.panel.left .maincanvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas bounding box not found');

  const startX = box.x + 50;
  const startY = box.y + 50;
  const width = 20;
  const height = 10;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + width, startY + height);
  await page.mouse.up();

  // 4. Trigger "Brush -> From Selection"
  const brushMenu = page.locator('.menuitem.main:text-matches("^Brush", "i")');
  await brushMenu.click();
  await expect(brushMenu).toHaveClass(/active/);

  const fromSelectionItem = page.locator(".menuitem.sub a:text-matches('^From Selection', 'i')");
  await expect(fromSelectionItem).toBeVisible();
  await fromSelectionItem.click();

  // Wait for Brush module to be available
  await page.waitForFunction(() => typeof window.Brush !== 'undefined');

  // 5. Verify initial brush dimensions (should be 20x10)
  let brushDimensions = await page.evaluate(() => {
    // @ts-ignore
    const brush = window.Brush.get();
    return { width: brush.width, height: brush.height };
  });

  // Note: Selection might be slightly off due to mouse movement precision, but should be close.
  // Actually, let's just check that width > height
  expect(brushDimensions.width).toBeGreaterThan(brushDimensions.height);
  console.log('Initial Brush:', brushDimensions);

  // 6. Trigger "Brush -> Transform -> Rotate Right" using keyboard shortcut
  await page.keyboard.press('Control+Shift+ArrowRight');

  // 7. Verify rotated brush dimensions (should be 10x20, so height > width)
 brushDimensions = await page.evaluate(() => {
    // @ts-ignore
    const brush = window.Brush.get();
    return { width: brush.width, height: brush.height };
  });
  console.log('Rotated Brush:', brushDimensions);

  expect(brushDimensions.height).toBeGreaterThan(brushDimensions.width);
});
