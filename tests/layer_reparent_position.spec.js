import {test, expect} from '@playwright/test';

test.beforeEach(async ({page})=>{
    await page.addInitScript(()=>localStorage.setItem('dp_about', 'true'));
    await page.goto('/');
    await page.waitForFunction(()=>window.ImageFile);
});

for (const kind of ['raster', 'group']) {
    for (const method of ['drop', 'moveLayer']) {
        test(`${method} preserves ${kind} pixels through nested reparenting and undo`, async ({page})=>{
            const result = await page.evaluate(async ({kind, method})=>{
                const {default: Layer} = await import('/_script/ui/layer.js');
                const {default: History} = await import('/_script/services/historyservice.js');
                const {COMMAND, EVENT} = await import('/_script/enum.js');
                const image = window.ImageFile;
                const {width: w, height: h} = image.getCurrentFile();
                const frame = image.getActiveFrame();
                const leaf = Layer(w, h, 'Paint');
                leaf.getContext().fillStyle = '#ff0000';
                leaf.getContext().fillRect(60, 60, 3, 3);
                const node = kind === 'group' ? Layer.makeGroup(w, h, 'Moving group') : leaf;
                if (kind === 'group') node.layers.push(leaf);
                node.x = 7;
                node.y = -4;
                const outer = Layer.makeGroup(w, h, 'Outer');
                outer.x = 20;
                outer.y = -10;
                const inner = Layer.makeGroup(w, h, 'Inner');
                inner.x = -8;
                inner.y = 15;
                outer.layers.push(inner);
                // Removing the source shifts the target's root index.
                frame.layers = [node, outer];
                image.activateLayer([0]);
                window.EventBus.trigger(EVENT.imageContentChanged);
                const pixels = ()=>Array.from(image.getCanvas().getContext('2d').getImageData(0, 0, w, h).data);
                const before = pixels();
                const move = (from, parent, index)=>{
                    if (method === 'drop') image.moveLayerToParent(from, parent, index);
                    else image.moveLayer(from, parent.concat(index));
                };
                History.start(EVENT.imageHistory);
                move([0], [1, 0], 0);
                History.end();
                const inside = pixels();
                const local = [node.x, node.y];
                window.EventBus.trigger(COMMAND.UNDO);
                await new Promise(resolve=>setTimeout(resolve, 100));
                const undone = pixels();
                const undoPath = image.getActiveLayerPath();
                window.EventBus.trigger(COMMAND.REDO);
                await new Promise(resolve=>setTimeout(resolve, 100));
                const redone = pixels();
                move([0, 0, 0], [], 1);
                const outside = pixels();
                return {
                    inside: inside.every((v, i)=>v === before[i]),
                    undone: undone.every((v, i)=>v === before[i]),
                    redone: redone.every((v, i)=>v === before[i]),
                    outside: outside.every((v, i)=>v === before[i]),
                    local, undoPath,
                    finalOffset: [image.getActiveLayer().x, image.getActiveLayer().y]
                };
            }, {kind, method});
            expect(result).toEqual({inside: true, undone: true, redone: true, outside: true,
                local: [-5, -9], undoPath: [0], finalOffset: [7, -4]});
        });
    }
}

test('drop compensates resolved offsets and existing animation entries', async ({page})=>{
    const result = await page.evaluate(async ()=>{
        const {default: Layer} = await import('/_script/ui/layer.js');
        const image = window.ImageFile;
        const {width: w, height: h} = image.getCurrentFile();
        const leaf = Layer(w, h, 'Animated paint');
        leaf.x = 3;
        leaf.y = 4;
        const group = Layer.makeGroup(w, h, 'Animated group');
        group.x = 10;
        group.y = 20;
        image.getActiveFrame().layers = [leaf, group];
        const track = image.getTracks()[0];
        const props = {
            [leaf.id]: {x: 13, y: 14, opacity: 75},
            [group.id]: {x: 30, y: -5, opacity: 100}
        };
        track.keys.push({frame: 1, type: 'property', props});
        image.activateFrame(1);
        image.activateLayer([0]);
        const before = image.getLayerOffset([0]);
        image.moveLayerToParent([0], [1], 0);
        return {before, after: image.getLayerOffset([0, 0]),
            base: [leaf.x, leaf.y], entry: props[leaf.id]};
    });
    expect(result.after).toEqual(result.before);
    expect(result.base).toEqual([-27, 9]);
    expect(result.entry).toEqual({x: -17, y: 19, opacity: 75});
});
