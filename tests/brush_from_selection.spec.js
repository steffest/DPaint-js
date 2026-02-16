import { test, expect } from '@playwright/test';

test('Create Brush from Selection', async ({ page }) => {
  page.on('dialog', d => d.dismiss());

  await page.addInitScript(() => {
    window.localStorage.setItem('dp_about', 'true');
  });

  page.on('console', msg => {
    if (msg.type() === 'error') console.log(msg.text());
  });
  // 1. Navigate to the app
  await page.goto('/index.html');
  await expect(page.locator('.panel.left .maincanvas')).toBeVisible();

  // About dialog is disabled via localStorage above.

  // 2. Select the "Select" tool
  const selectTool = page.locator('.button.icon.select');
  await selectTool.click();
  await expect(selectTool).toHaveClass(/active/);

  // 3. Make a selection on the canvas
  const canvas = page.locator('.panel.left .maincanvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas bounding box not found');

  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.up();

  // Debug: Log all menu items
  await page.evaluate(() => {
    const items = document.querySelectorAll('.menuitem.main');
    items.forEach(item => console.log('Menu Item:', item.textContent, item.outerHTML));
  });

  // 4. Trigger "Brush -> From Selection"
  const brushMenu = page.locator('.menuitem.main:text-matches("^Brush", "i")');
  await brushMenu.click();
  await expect(brushMenu).toHaveClass(/active/);

  let fromSelectionItem = page.locator(".menuitem.sub a:text-matches('^From Selection', 'i')");
  await expect(fromSelectionItem).toBeVisible();
  await fromSelectionItem.click();

  // 5. Verify that the "Draw" tool (Pencil) is now active
  const pencilTool = page.locator('.button.icon.pencil');
  await expect(pencilTool).toHaveClass(/active/);

  // Verify "Select" tool is NOT active
  await expect(selectTool).not.toHaveClass(/active/);
});
