// @ts-check
import { test, expect } from '@playwright/test';

test('Create New Canvas', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('.panel.left .maincanvas')).toBeVisible();

  const fileMenu = page.locator('.menuitem.main:text-matches("^File", "i")');
  await fileMenu.click();

  await expect(fileMenu).toHaveClass(/active/);
  const newItem = fileMenu.locator('.menuitem.sub a:text-matches("^New", "i")');
  await expect(newItem).toBeVisible();
  await newItem.click();

  // Verify Canvas Dimensions
  const canvas = page.locator('.panel.left .maincanvas');
  await expect(canvas).toHaveAttribute('width', '320');
  await expect(canvas).toHaveAttribute('height', '256');


  // verify the canvas is blank (transparent).
  const isBlank = await page.evaluate(() => {
    const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.panel.left .maincanvas'));
    if (!canvas) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] !== 0) return false; // Alpha should be 0
    }
    return true;
  });
  expect(isBlank).toBe(true);


});
