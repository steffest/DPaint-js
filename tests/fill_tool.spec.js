import { test, expect } from '@playwright/test';

test('Fill Tool Functionality', async ({ page }) => {
  // 1. Navigate to the app
  await page.goto('/index.html');
  await expect(page.locator('.panel.left .maincanvas')).toBeVisible();

  // Wait for the "About" panel to appear and close it
  const aboutPanel = page.locator('.modalwindow');
  await expect(aboutPanel).toBeVisible();
  // Click the close button (x) in the caption
  await page.locator('.modalwindow .caption .button').click();
  await expect(aboutPanel).toBeHidden();

  // Helper to select color from palette
  // Palette items are 14x14 pixels, 4 columns.
  // Index 3 (Blue): Row 0, Col 3 -> x=42, y=0. Center: 49, 7
  // Index 7 (Pink): Row 1, Col 3 -> x=42, y=14. Center: 49, 21
  async function selectColor(index) {
    const palette = page.locator('.info.palettecanvas');
    const size = 14;
    const cols = 4;
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = col * size + size / 2;
    const y = row * size + size / 2;
    
    await palette.click({ position: { x, y } });
    
    // Check if Palette Editor opened (e.g. due to double click) and close it
    const modal = page.locator('.modalwindow');
    if (await modal.isVisible()) {
        console.log('Palette Editor opened unexpectedly, closing it.');
        await page.locator('.modalwindow .caption .button').click();
        await expect(modal).toBeHidden();
    }
  }

  // Helper to get canvas pixel color at center
  async function getCanvasColor() {
    return await page.evaluate(() => {
      const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.panel.left .maincanvas'));
      if (!canvas) return [0, 0, 0];
      const ctx = canvas.getContext('2d');
      if (!ctx) return [0, 0, 0];
      const x = canvas.width / 2;
      const y = canvas.height / 2;
      const p = ctx.getImageData(x, y, 1, 1).data;
      return [p[0], p[1], p[2]];
    });
  }

  // 2. Select a color (Index 3: Blue [59,103,162])
  await selectColor(3);

  // 3. Select the Fill tool
  const fillTool = page.locator('.button.icon.flood');
  await fillTool.click();
  await expect(fillTool).toHaveClass(/active/);

  // 4. Click on the canvas to fill
  const canvas = page.locator('.panel.left .maincanvas');
  await canvas.click();

  // 5. Verify canvas is filled with Blue
  let color = await getCanvasColor();
  expect(color).toEqual([59, 103, 162]);

  // 6. Select another color (Index 7: Pink [255,169,151])
  await selectColor(7);

  // 7. Click on the canvas to fill again
  await canvas.click();

  // 8. Verify canvas is filled with Pink
  color = await getCanvasColor();
  expect(color).toEqual([255, 169, 151]);
});
