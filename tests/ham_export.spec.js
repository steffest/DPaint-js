// @ts-check
import { test, expect } from '@playwright/test';

// Helper to parse IFF chunks from an ArrayBuffer.
function parseIFFChunks(buffer) {
    const view = new DataView(buffer);
    const chunks = {};

    // FORM header: "FORM" + size + "ILBM"
    const formTag = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (formTag !== 'FORM') return chunks;
    const formType = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    chunks.formType = formType;

    let offset = 12;
    while (offset < buffer.byteLength - 8) {
        const tag = String.fromCharCode(
            view.getUint8(offset), view.getUint8(offset+1),
            view.getUint8(offset+2), view.getUint8(offset+3)
        );
        const size = view.getUint32(offset + 4);
        const dataStart = offset + 8;

        if (tag === 'BMHD') {
            chunks.bmhd = {
                width: view.getUint16(dataStart),
                height: view.getUint16(dataStart + 2),
                nPlanes: view.getUint8(dataStart + 8)
            };
        } else if (tag === 'CAMG') {
            chunks.camg = view.getUint32(dataStart);
        } else if (tag === 'SHAM') {
            chunks.sham = {
                version: view.getUint16(dataStart),
                dataSize: size
            };
        } else if (tag === 'CMAP') {
            chunks.cmapSize = size;
        } else if (tag === 'BODY') {
            chunks.bodySize = size;
        }

        // Advance past chunk data (padded to even).
        offset = dataStart + size;
        if (offset & 1) offset++;
    }
    return chunks;
}

test('Export HAM6 IFF', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('.panel.left .maincanvas')).toBeVisible();

    // Close the About panel if it appears.
    const aboutPanel = page.locator('.modalwindow');
    if (await aboutPanel.isVisible({ timeout: 2000 }).catch(() => false)) {
        await page.locator('.modalwindow .caption .button').click();
        await expect(aboutPanel).toBeHidden();
    }

    // Fill canvas with a color so it's not blank.
    await page.evaluate(() => {
        const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.panel.left .maincanvas'));
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        // Paint a gradient to give the HAM encoder something to work with.
        for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
                ctx.fillStyle = `rgb(${x % 256}, ${y % 256}, ${(x + y) % 256})`;
                ctx.fillRect(x, y, 1, 1);
            }
        }
    });

    // Call the IFF writer directly via page.evaluate to get the binary output.
    const result = await page.evaluate(async () => {
        // @ts-ignore — access app globals
        const Generate = window.Generate;
        if (!Generate) return { error: 'Generate not found' };

        const res = await Generate.file('IFF', { iffMode: 'ham6' });
        if (res.result !== 'ok') return { error: res.messages?.join(', ') || 'unknown error' };

        // Convert Blob to ArrayBuffer and return as array.
        const ab = await res.file.arrayBuffer();
        return { data: Array.from(new Uint8Array(ab)) };
    });

    expect(result.error).toBeUndefined();
    expect(result.data).toBeDefined();

    const buffer = new Uint8Array(result.data).buffer;
    const chunks = parseIFFChunks(buffer);

    expect(chunks.formType).toBe('ILBM');
    expect(chunks.bmhd).toBeDefined();
    expect(chunks.bmhd.nPlanes).toBe(6);
    expect(chunks.camg).toBe(0x0800); // HAM flag
    expect(chunks.cmapSize).toBe(16 * 3); // 16-color palette
    expect(chunks.bodySize).toBeGreaterThan(0);
});

test('Export HAM8 IFF', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('.panel.left .maincanvas')).toBeVisible();

    const aboutPanel = page.locator('.modalwindow');
    if (await aboutPanel.isVisible({ timeout: 2000 }).catch(() => false)) {
        await page.locator('.modalwindow .caption .button').click();
        await expect(aboutPanel).toBeHidden();
    }

    // Fill canvas with colors.
    await page.evaluate(() => {
        const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.panel.left .maincanvas'));
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = 'rgb(200, 100, 50)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    });

    const result = await page.evaluate(async () => {
        // @ts-ignore
        const Generate = window.Generate;
        if (!Generate) return { error: 'Generate not found' };
        const res = await Generate.file('IFF', { iffMode: 'ham8' });
        if (res.result !== 'ok') return { error: res.messages?.join(', ') || 'unknown error' };
        const ab = await res.file.arrayBuffer();
        return { data: Array.from(new Uint8Array(ab)) };
    });

    expect(result.error).toBeUndefined();

    const buffer = new Uint8Array(result.data).buffer;
    const chunks = parseIFFChunks(buffer);

    expect(chunks.formType).toBe('ILBM');
    expect(chunks.bmhd.nPlanes).toBe(8);
    expect(chunks.camg).toBe(0x0800);
    expect(chunks.cmapSize).toBe(64 * 3); // 64-color palette
});

test('Export SHAM IFF', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('.panel.left .maincanvas')).toBeVisible();

    const aboutPanel = page.locator('.modalwindow');
    if (await aboutPanel.isVisible({ timeout: 2000 }).catch(() => false)) {
        await page.locator('.modalwindow .caption .button').click();
        await expect(aboutPanel).toBeHidden();
    }

    // Fill canvas.
    await page.evaluate(() => {
        const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.panel.left .maincanvas'));
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = 'rgb(100, 150, 200)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    });

    const result = await page.evaluate(async () => {
        // @ts-ignore
        const Generate = window.Generate;
        if (!Generate) return { error: 'Generate not found' };
        const res = await Generate.file('IFF', { iffMode: 'sham' });
        if (res.result !== 'ok') return { error: res.messages?.join(', ') || 'unknown error' };
        const ab = await res.file.arrayBuffer();
        return { data: Array.from(new Uint8Array(ab)) };
    });

    expect(result.error).toBeUndefined();

    const buffer = new Uint8Array(result.data).buffer;
    const chunks = parseIFFChunks(buffer);

    expect(chunks.formType).toBe('ILBM');
    expect(chunks.bmhd.nPlanes).toBe(6);
    expect(chunks.camg).toBe(0x0800);
    expect(chunks.cmapSize).toBe(16 * 3);
    // SHAM chunk should be present.
    expect(chunks.sham).toBeDefined();
    expect(chunks.sham.version).toBe(0);
    // SHAM data size = 2 (version) + height * 32 (16 words per scanline).
    const expectedHeight = chunks.bmhd.height;
    expect(chunks.sham.dataSize).toBe(2 + expectedHeight * 32);
});

test('Standard IFF export unchanged', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('.panel.left .maincanvas')).toBeVisible();

    const aboutPanel = page.locator('.modalwindow');
    if (await aboutPanel.isVisible({ timeout: 2000 }).catch(() => false)) {
        await page.locator('.modalwindow .caption .button').click();
        await expect(aboutPanel).toBeHidden();
    }

    // Fill canvas with a single color.
    await page.evaluate(() => {
        const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.panel.left .maincanvas'));
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = 'rgb(255, 0, 0)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    });

    // Standard mode (no iffMode or iffMode="standard").
    const result = await page.evaluate(async () => {
        // @ts-ignore
        const Generate = window.Generate;
        if (!Generate) return { error: 'Generate not found' };
        const res = await Generate.file('IFF', {});
        if (res.result !== 'ok') return { error: res.messages?.join(', ') || 'unknown error' };
        const ab = await res.file.arrayBuffer();
        return { data: Array.from(new Uint8Array(ab)) };
    });

    expect(result.error).toBeUndefined();

    const buffer = new Uint8Array(result.data).buffer;
    const chunks = parseIFFChunks(buffer);

    expect(chunks.formType).toBe('ILBM');
    // Standard mode: no CAMG, no SHAM.
    expect(chunks.camg).toBeUndefined();
    expect(chunks.sham).toBeUndefined();
    expect(chunks.bodySize).toBeGreaterThan(0);
});
