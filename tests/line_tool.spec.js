// @ts-check
import { test, expect } from '@playwright/test';

test('Line Tool Functionality', async ({ page }) => {
  page.on('dialog', d => d.dismiss());

  await page.addInitScript(() => {
    window.localStorage.setItem('dp_about', 'true');
  });

  // 1. Navigate to the app
  await page.goto('/index.html');
  await expect(page.locator('.panel.left .maincanvas')).toBeVisible();

  // 2. Select the Line tool
  const lineTool = page.locator('.button.icon.line');
  await lineTool.click();
  await expect(lineTool).toHaveClass(/active/);

  // 3. Draw a horizontal line (50, 50) -> (150, 50)
  const canvas = page.locator('.panel.left .maincanvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas bounding box not found');

  const { scaleX, scaleY } = await page.evaluate(() => {
    const c = /** @type {HTMLCanvasElement} */ (document.querySelector('.panel.left .maincanvas'));
    const r = c.getBoundingClientRect();
    return { scaleX: r.width / c.width, scaleY: r.height / c.height };
  });

  const toPage = (x, y) => ({
    x: box.x + x * scaleX,
    y: box.y + y * scaleY,
  });

  const p1 = toPage(50, 50);
  const p2 = toPage(150, 50);

  await page.mouse.move(p1.x, p1.y);
  await page.mouse.down();
  await page.mouse.move(p2.x, p2.y);
  await page.mouse.up();

  // 4. Draw a vertical line (50, 50) -> (50, 150)
  const p3 = toPage(50, 150);

  await page.mouse.move(p1.x, p1.y);
  await page.mouse.down();
  await page.mouse.move(p3.x, p3.y);
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

  // 5. Verify pixels (allow small tolerance for scaling / snapping)
  async function expectOpaqueNear(x, y) {
    const samples = [
      await getPixelColor(x, y),
      await getPixelColor(x - 1, y),
      await getPixelColor(x + 1, y),
      await getPixelColor(x, y - 1),
      await getPixelColor(x, y + 1),
    ];
    const anyOpaque = samples.some(p => p[3] > 0);
    expect(anyOpaque).toBe(true);
  }

  await expectOpaqueNear(100, 50); // horizontal line
  await expectOpaqueNear(50, 100); // vertical line
  await expectOpaqueNear(50, 50);  // intersection

  // Check point NOT on line (should be transparent or background)
  // Default background is transparent [0, 0, 0, 0] or white depending on init
  // Based on previous tests, it seems to be transparent or white.
  // Let's check a point far away.
  const color = await getPixelColor(200, 200);
  // Expecting transparent or white. Let's check alpha.
  // If alpha is 0, it's transparent.
  if (color[3] !== 0) {
      // If not transparent, assume white background [255, 255, 255, 255]
      expect(color).toEqual([255, 255, 255, 255]);
  }
});
