import { test, expect } from '@playwright/test';

test('Fill Tool Functionality', async ({ page }) => {
  page.on('dialog', d => d.dismiss());

  await page.addInitScript(() => {
    window.localStorage.setItem('dp_about', 'true');
  });

  // 1. Navigate to the app
  await page.goto('/index.html');
  await expect(page.locator('.panel.left .maincanvas')).toBeVisible();

  // Helper to select color from palette
  async function selectColor(index) {
    const palette = page.locator('.info.palettecanvas');
    const cols = 4;
    const col = index % cols;
    const row = Math.floor(index / cols);

    const { w, h } = await page.evaluate(() => {
      const c = /** @type {HTMLCanvasElement} */ (document.querySelector('.info.palettecanvas'));
      return { w: c.width, h: c.height };
    });
    const cellW = w / cols;
    const cellH = h / cols;
    const x = col * cellW + cellW / 2;
    const y = row * cellH + cellH / 2;
    
    await palette.click({ position: { x, y } });
    
    // Check if Palette Editor opened (e.g. due to double click) and close it
    const modal = page.locator('.modalwindow');
    if (await modal.isVisible()) {
        console.log('Palette Editor opened unexpectedly, closing it.');
        await page.locator('.modalwindow .caption .button').click();
        await expect(modal).toBeHidden();
    }
  }

  async function getCanvasPixel(x, y) {
    return await page.evaluate(({ x, y }) => {
      const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.panel.left .maincanvas'));
      if (!canvas) return [0, 0, 0, 0];
      const ctx = canvas.getContext('2d');
      if (!ctx) return [0, 0, 0, 0];
      const p = ctx.getImageData(x, y, 1, 1).data;
      return [p[0], p[1], p[2], p[3]];
    }, { x, y });
  }

  async function getCanvasCenterPixel() {
    return await page.evaluate(() => {
      const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.panel.left .maincanvas'));
      const x = Math.floor(canvas.width / 2);
      const y = Math.floor(canvas.height / 2);
      const ctx = canvas.getContext('2d');
      const p = ctx.getImageData(x, y, 1, 1).data;
      return [p[0], p[1], p[2], p[3]];
    });
  }

  async function getPaletteSwatchColor(index) {
    const cols = 4;
    const col = index % cols;
    const row = Math.floor(index / cols);
    return await page.evaluate(({ col, row, cols }) => {
      const c = /** @type {HTMLCanvasElement} */ (document.querySelector('.info.palettecanvas'));
      const ctx = c.getContext('2d');
      const cellW = c.width / cols;
      const cellH = c.height / cols;
      const x = Math.floor(col * cellW + cellW / 2);
      const y = Math.floor(row * cellH + cellH / 2);
      const p = ctx.getImageData(x, y, 1, 1).data;
      return [p[0], p[1], p[2]];
    }, { col, row, cols });
  }

  // 2. Select a color (Index 3)
  const expected1 = await getPaletteSwatchColor(3);
  await selectColor(3);

  // 3. Select the Fill tool
  const fillTool = page.locator('.button.icon.flood');
  await fillTool.click();
  await expect(fillTool).toHaveClass(/active/);

  // 4. Click on the canvas to fill
  const canvas = page.locator('.panel.left .maincanvas');
  await canvas.click();

  // 5. Verify canvas is filled with the selected palette color
  let p = await getCanvasCenterPixel();
  expect(p[3]).toBe(255);
  expect(p.slice(0, 3)).toEqual(expected1);

  // 6. Select another color (Index 7)
  const expected2 = await getPaletteSwatchColor(7);
  await selectColor(7);

  // 7. Click on the canvas to fill again
  await canvas.click();

  // 8. Verify canvas is filled with the new selected palette color
  p = await getCanvasCenterPixel();
  expect(p[3]).toBe(255);
  expect(p.slice(0, 3)).toEqual(expected2);
});
