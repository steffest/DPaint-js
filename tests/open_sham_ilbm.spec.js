// @ts-check
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';

test('Open SHAM ILBM Renders Per-Scanline Palette', async ({ page }) => {
  page.on('dialog', d => d.dismiss());

  // Avoid the first-run about dialog interfering with menu interaction.
  await page.addInitScript(() => {
    window.localStorage.setItem('dp_about', 'true');
  });

  await page.goto('/index.html');
  await expect(page.locator('.panel.left .maincanvas')).toBeVisible();

  const fileMenu = page.locator('.menuitem.main:text-matches("^File", "i")');
  await fileMenu.click();
  await expect(fileMenu).toHaveClass(/active/);

  // Menu items include shortcut text, so match "Open" prefix rather than exact.
  const openItem = fileMenu.locator('.menuitem.sub a:text-matches("^Open", "i")').first();
  await expect(openItem).toBeVisible();

  const fixturePath = fileURLToPath(new URL('./fixtures/sham-16x4-ham6.ilbm', import.meta.url));
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    openItem.click(),
  ]);
  await chooser.setFiles(fixturePath);

  const canvas = page.locator('.panel.left .maincanvas');
  await expect(canvas).toHaveAttribute('width', '16');
  await expect(canvas).toHaveAttribute('height', '4');

  const pixels = await page.evaluate(() => {
    const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.panel.left .maincanvas'));
    const ctx = canvas.getContext('2d');
    const sample = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return [
      sample(0, 0), // red
      sample(0, 1), // green
      sample(0, 2), // blue
      sample(0, 3), // yellow
    ];
  });

  expect(pixels[0].slice(0, 3)).toEqual([255, 0, 0]);
  expect(pixels[1].slice(0, 3)).toEqual([0, 255, 0]);
  expect(pixels[2].slice(0, 3)).toEqual([0, 0, 255]);
  expect(pixels[3].slice(0, 3)).toEqual([255, 255, 0]);
});

test('Open Real SHAM ILBM 320x256', async ({ page }) => {
  page.on('dialog', d => d.dismiss());

  await page.addInitScript(() => {
    window.localStorage.setItem('dp_about', 'true');
  });

  await page.goto('/index.html');
  await expect(page.locator('.panel.left .maincanvas')).toBeVisible();

  const fileMenu = page.locator('.menuitem.main:text-matches("^File", "i")');
  await fileMenu.click();
  await expect(fileMenu).toHaveClass(/active/);

  const openItem = fileMenu.locator('.menuitem.sub a:text-matches("^Open", "i")').first();
  await expect(openItem).toBeVisible();

  const fixturePath = fileURLToPath(new URL('./fixtures/TEST_IMAGE_320x256_SHAM.iff', import.meta.url));
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    openItem.click(),
  ]);
  await chooser.setFiles(fixturePath);

  const canvas = page.locator('.panel.left .maincanvas');
  await expect(canvas).toHaveAttribute('width', '320');
  await expect(canvas).toHaveAttribute('height', '256');

  // Verify the image has non-transparent pixel data (loaded successfully).
  const hasContent = await page.evaluate(() => {
    const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.panel.left .maincanvas'));
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonTransparent = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) nonTransparent++;
    }
    return nonTransparent > 0;
  });
  expect(hasContent).toBe(true);
});
