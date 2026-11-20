import {test, expect} from '@playwright/test';

for (const scenario of ['resize', 'grow', 'move then resize']) {
    for (const commit of [false, true]) {
        test(`${scenario} can undo and redo ${commit ? 'after commit' : 'while transform is active'}`, async ({page})=>{
            await page.addInitScript(()=>localStorage.setItem('dp_about', 'true'));
            await page.goto('/');
            await page.waitForFunction(()=>window.ImageFile);
            await page.evaluate(async ()=>{
                const {COMMAND, EVENT} = await import('/_script/enum.js');
                const History = (await import('/_script/services/historyservice.js')).default;
                const layer = window.ImageFile.getActiveLayer();
                layer.clear();
                layer.getContext().fillStyle = '#ff0000';
                layer.getContext().fillRect(50, 50, 80, 60);
                window.EventBus.trigger(EVENT.layerContentChanged);
                History.clear();
                window.__resizeState = ()=>{
                    const l = window.ImageFile.getActiveLayer();
                    const c = l.getCanvas();
                    return {x:l.x, y:l.y, cx:l.canvasX, cy:l.canvasY, w:c.width, h:c.height,
                        pixels:c.toDataURL()};
                };
                window.EventBus.trigger(COMMAND.TRANSFORMLAYER);
            });
            const before = await page.evaluate(()=>window.__resizeState());
            if (scenario === 'move then resize') {
                await page.evaluate(async ()=>{
                    const Editor = (await import('/_script/ui/editor.js')).default;
                    Editor.getActivePanel().getResizer().move(10, 10);
                });
            }
            const handle = await page.locator('.sizebox.active .sizedot').nth(scenario === 'grow' ? 0 : 3).boundingBox();
            const zoom = await page.evaluate(async ()=>(await import('/_script/ui/editor.js')).default.getActivePanel().getZoom());
            const x = handle.x+handle.width/2, y = handle.y+handle.height/2;
            await page.mouse.move(x,y);
            await page.mouse.down();
            await page.mouse.move(x + (scenario === 'grow' ? -70 : 30)*zoom, y, {steps:4});
            await page.mouse.up();
            if (commit) await page.evaluate(async ()=>await (await import('/_script/ui/editor.js')).default.commit());
            const resized = await page.evaluate(()=>window.__resizeState());
            expect(resized.pixels).not.toEqual(before.pixels);
            await page.evaluate(()=>window.EventBus.trigger(window.COMMAND.UNDO));
            await expect.poll(()=>page.evaluate(()=>window.__resizeState())).toEqual(before);
            await page.evaluate(()=>window.EventBus.trigger(window.COMMAND.REDO));
            await expect.poll(()=>page.evaluate(()=>window.__resizeState())).toEqual(resized);
        });
    }
}
