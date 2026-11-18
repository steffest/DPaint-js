import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('dp_about', 'true'));
    await page.goto('/index.html');
    await page.waitForFunction(() => window.ImageFile && window.Brush);
});

for (const version of ['1', '2']) {
    test(`loads a v${version} DPaint file as a brush without replacing the document`, async ({ page }) => {
        const result = await page.evaluate(async (version) => {
            const source = document.createElement('canvas');
            source.width = 7;
            source.height = 11;
            source.getContext('2d').fillRect(2, 3, 1, 1);
            const layer = { canvas: source.toDataURL() };
            const image = version === '1'
                ? { frames: [{ layers: [layer] }] }
                : { timeline: { tracks: [
                    { keys: [{ frame: 0, type: 'blank' }] },
                    { keys: [
                        { frame: 3, type: 'content', cel: { layers: [layer] } },
                        { frame: 0, type: 'content', cel: { layers: [layer] } }
                    ] }
                ] } };
            const before = window.ImageFile.getCurrentFile();
            // Wait for the actual image decode and brush update.
            await new Promise((resolve, reject) => {
                const originalSet = window.Brush.set;
                window.Brush.set = function (...args) {
                    window.Brush.set = originalSet;
                    try { originalSet.apply(this, args); resolve(); }
                    catch (error) { reject(error); }
                };
                window.ImageFile.handleJSON({ type: 'dpaint', version, image }, 'brush');
            });
            const exported = window.Brush.export();
            const decoded = new Image();
            decoded.src = exported.image.frames[0].layers[0].canvas;
            await decoded.decode();
            const output = document.createElement('canvas');
            output.width = decoded.width;
            output.height = decoded.height;
            const ctx = output.getContext('2d');
            ctx.drawImage(decoded, 0, 0);
            return {
                width: decoded.width, height: decoded.height,
                ink: ctx.getImageData(2, 3, 1, 1).data[3],
                transparent: ctx.getImageData(0, 0, 1, 1).data[3],
                sameDocument: before === window.ImageFile.getCurrentFile()
            };
        }, version);
        expect(result).toEqual({ width: 7, height: 11, ink: 255, transparent: 0, sameDocument: true });
    });
}

test('reports an empty v2 document without changing the brush', async ({ page }) => {
    const result = await page.evaluate(() => {
        const before = JSON.stringify(window.Brush.export());
        let message;
        try {
            window.ImageFile.handleJSON({ type: 'dpaint', image: { timeline: { tracks: [] } } }, 'brush');
        } catch (error) { message = error.message; }
        return { message, unchanged: before === JSON.stringify(window.Brush.export()) };
    });
    expect(result.message).toContain('no raster layer');
    expect(result.unchanged).toBe(true);
});

for (const version of ['1', '2']) {
    test(`Tab cycles every v${version} brush frame and restores palette cycling for a static brush`, async ({ page }) => {
        await page.evaluate(async version => {
            const { default: EventBus } = await import('/_script/util/eventbus.js');
            const { COMMAND } = await import('/_script/enum.js');
            window.__paletteCycles = 0;
            EventBus.on(COMMAND.CYCLEPALETTE, () => window.__paletteCycles++);
            EventBus.on(COMMAND.CYCLEPALETTESTEP, () => window.__paletteCycles++);
            const frames = ['red', 'green', 'blue'].map(color => {
                const canvas = document.createElement('canvas');
                canvas.width = 6;
                canvas.height = 4;
                canvas.getContext('2d').fillStyle = color;
                canvas.getContext('2d').fillRect(0, 0, 6, 4);
                return { layers: [{ canvas: canvas.toDataURL() }] };
            });
            const image = version === '1' ? { frames } : { timeline: { tracks: [{ keys:
                frames.map((cel, frame) => ({ frame, type: 'content', cel })).reverse()
            }] } };
            await window.Brush.import({ type: 'dpaint', version, image });
            window.Brush.setOpacity(63);
        }, version);
        const info = page.locator('.statusbar-brush-info');
        await expect(info).toContainText('Brush: 1/3');
        for (const [key, index, color] of [
            ['Tab', 1, [0, 128, 0, 255]],
            ['Shift+Tab', 2, [0, 0, 255, 255]],
            ['Tab', 0, [255, 0, 0, 255]]
        ]) {
            await page.keyboard.press(key);
            await expect(info).toContainText(`Brush: ${index + 1}/3`);
            const result = await page.evaluate(() => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 40;
                const ctx = canvas.getContext('2d');
                const bounds = window.Brush.draw(ctx, 20, 20, '#000', false, false, false);
                return {
                    frame: window.Brush.getFrameInfo(), bounds,
                    center: [...ctx.getImageData(20, 20, 1, 1).data],
                    outside: ctx.getImageData(16, 17, 1, 1).data[3],
                    opacity: window.Brush.getOpacity(), cycles: window.__paletteCycles
                };
            });
            expect(result.frame).toEqual({ index, count: 3 });
            expect(result.bounds).toMatchObject({ x: 17, y: 18, width: 6, height: 4 });
            expect(result.center).toEqual(color);
            expect(result.outside).toBe(0);
            expect(result.opacity).toBe(0.63);
            expect(result.cycles).toBe(0);
        }
        await page.evaluate(() => window.Brush.set('canvas', document.createElement('canvas')));
        await expect(info).not.toContainText('Brush:');
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => window.__paletteCycles)).toBe(1);
    });
}

test('centres pressure-sized brush stamps using their final dimensions', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { default: ToolOptions } = await import('/_script/ui/components/toolOptions.js');
        ToolOptions.usePressure = () => true;
        const image = document.createElement('canvas');
        image.width = 6;
        image.height = 4;
        window.Brush.set('canvas', image);
        window.Brush.setPressure(0.5);
        // Deterministic pressure sizing: final stamp is 22.5 x 15.
        Math.random = () => 0.5;
        const target = document.createElement('canvas');
        return window.Brush.draw(target.getContext('2d'), 50, 50, '#000', false, false, true, true);
    });
    expect(result).toMatchObject({ x: 39, y: 43, width: 22.5, height: 15 });
});

test('keeps the brush preview visible while zooming without moving the pointer', async ({ page }) => {
    await page.evaluate(async () => {
        const { default: EventBus } = await import('/_script/util/eventbus.js');
        const { COMMAND } = await import('/_script/enum.js');
        EventBus.trigger(COMMAND.DRAW);
        const brush = document.createElement('canvas');
        brush.width = brush.height = 8;
        brush.getContext('2d').fillRect(0, 0, 8, 8);
        window.Brush.set('canvas', brush);
    });
    const canvas = page.locator('.panel.left .maincanvas');
    const overlay = page.locator('.panel.left .overlaycanvas');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(overlay).toHaveCSS('opacity', '1');
    const before = await canvas.boundingBox();
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => (await canvas.boundingBox()).width).toBeGreaterThan(before.width);
    await expect(overlay).toHaveCSS('opacity', '1');
    expect(await overlay.evaluate(c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v,i) => i % 4 === 3 && v > 0))).toBe(true);
    await page.mouse.wheel(0, 120);
    await expect.poll(async () => (await canvas.boundingBox()).width).toBe(before.width);
    await expect(overlay).toHaveCSS('opacity', '1');
});
