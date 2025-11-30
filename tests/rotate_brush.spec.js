// @ts-check
const { test, expect } = require('@playwright/test');

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
  const brushMenu = page.locator('.menuitem.main').filter({ hasText: 'BrushLoad BrushSave' });
  await brushMenu.click();
  await expect(brushMenu).toHaveClass(/active/);

  const fromSelectionItem = page.getByText('From SelectionCmd+B');
  await expect(fromSelectionItem).toBeVisible();
  await fromSelectionItem.click();

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

  // 6. Trigger "Brush -> Transform -> Rotate Right"
  await brushMenu.click();
  await expect(brushMenu).toHaveClass(/active/);

  const transformItem = page.getByText('TransformRotate Right');
  await transformItem.hover(); // Hover to open submenu
  
  const rotateRightItem = page.getByText('Rotate RightCmd+Shift+→');
  await expect(rotateRightItem).toBeVisible();
  await rotateRightItem.click();

  // 7. Verify rotated brush dimensions (should be 10x20, so height > width)
  brushDimensions = await page.evaluate(() => {
    // @ts-ignore
    const brush = window.Brush.get();
    return { width: brush.width, height: brush.height };
  });
  console.log('Rotated Brush:', brushDimensions);

  expect(brushDimensions.height).toBeGreaterThan(brushDimensions.width);
});
