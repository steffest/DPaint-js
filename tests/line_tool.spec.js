// @ts-check
import { test, expect } from '@playwright/test';

test('Line Tool Functionality', async ({ page }) => {
  // 1. Navigate to the app
  await page.goto('/index.html');
  await expect(page.locator('.panel.left .maincanvas')).toBeVisible();

  // Wait for the "About" panel to appear and close it
  const aboutPanel = page.locator('.modalwindow');
  await expect(aboutPanel).toBeVisible();
  // Click the close button (x) in the caption
  await page.locator('.modalwindow .caption .button').click();
  await expect(aboutPanel).toBeHidden();

  // 2. Select the Line tool
  const lineTool = page.locator('.button.icon.line');
  await lineTool.click();
  await expect(lineTool).toHaveClass(/active/);

  // 3. Draw a horizontal line (50, 50) -> (150, 50)
  const canvas = page.locator('.panel.left .maincanvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas bounding box not found');

  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 50);
  await page.mouse.up();

  // 4. Draw a vertical line (50, 50) -> (50, 150)
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + 150);
  await page.mouse.up();

  // Helper to get canvas pixel color at (x, y)
  async function getPixelColor(x, y) {
    return await page.evaluate(({ x, y }) => {
      const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.panel.left .maincanvas'));
      if (!canvas) return [0, 0, 0, 0];
      const ctx = canvas.getContext('2d');
      if (!ctx) return [0, 0, 0, 0];
      const p = ctx.getImageData(x, y, 1, 1).data;
      return [p[0], p[1], p[2], p[3]];
    }, { x, y });
  }

  // 5. Verify pixels
  // Default draw color is black [0, 0, 0, 255]
  
  // Check point on horizontal line
  let color = await getPixelColor(100, 50);
  expect(color).toEqual([0, 0, 0, 255]);

  // Check point on vertical line
  color = await getPixelColor(50, 100);
  expect(color).toEqual([0, 0, 0, 255]);

  // Check intersection
  color = await getPixelColor(50, 50);
  expect(color).toEqual([0, 0, 0, 255]);

  // Check point NOT on line (should be transparent or background)
  // Default background is transparent [0, 0, 0, 0] or white depending on init
  // Based on previous tests, it seems to be transparent or white.
  // Let's check a point far away.
  color = await getPixelColor(200, 200);
  // Expecting transparent or white. Let's check alpha.
  // If alpha is 0, it's transparent.
  if (color[3] !== 0) {
      // If not transparent, assume white background [255, 255, 255, 255]
      expect(color).toEqual([255, 255, 255, 255]);
  }
});
