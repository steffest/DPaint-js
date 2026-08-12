import {EVENT} from "../enum.js";

let ClientApi = (()=>{

    let me = {};

    me.init = ()=>{
        window.DPaintAPI = (() => {

            // ─── INTERNAL HELPERS ────────────────────────────────────────────────

            function triggerMenuItem(labelText) {
                const links = Array.from(document.querySelectorAll('a.handle'));
                const el = links.find(a =>
                    a.textContent.trim().replace(/\s+/g, ' ').startsWith(labelText)
                );
                if (el?.onClick) { el.onClick(new MouseEvent('click')); return true; }
                return false;
            }

            function triggerToolButton(toolClass) {
                const btn = document.querySelector(`.button.icon.${toolClass}`);
                if (btn?.onClick) { btn.onClick(new MouseEvent('click')); return true; }
                return false;
            }

            function getActiveFrame() {
                const file = getCurrentFile();
                // You'll want to track activeFrameIndex in your state; for now assume 0
                return file?.frames?.[0];
            }

            function getActiveLayer() {
                const frame = getActiveFrame();
                return frame?.layers?.[frame.activeLayerIndex ?? 0];
            }


            // ─── 1. TOOLS ────────────────────────────────────────────────────────

            const tools = {
                // Valid names: pencil, select, polygonselect, floodselect,
                //              circle, square, line, curve, gradient, flood,
                //              spray, smudge, erase, pan, picker, zoom, zoomout
                setTool(name) {
                    return triggerToolButton(name);
                },

                getActiveTool() {
                    const active = document.querySelector('.button.icon.active');
                    return active
                        ? [...active.classList].find(c => !['button','handle','info','icon','active','disabled'].includes(c))
                        : null;
                }
            };


            // ─── 2. COLOR ────────────────────────────────────────────────────────

            const color = {
                // Set the foreground (draw) color. hex = '#rrggbb'
                setForeground(hex) {
                    const inp = document.querySelector('input[type=color]');
                    inp.isBack = false;
                    inp.value = hex;
                    inp.dispatchEvent(new Event('input',  { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                },

                // Set the background color
                setBackground(hex) {
                    // Temporarily point the picker at the background slot
                    const backEl = document.querySelector('.back.info.handle');
                    if (backEl?.onClick) backEl.onClick(new MouseEvent('click'));
                    const inp = document.querySelector('input[type=color]');
                    inp.isBack = true;
                    inp.value = hex;
                    inp.dispatchEvent(new Event('input',  { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                },

                getForeground() {
                    return window.getComputedStyle(
                        document.querySelector('.front.info.handle')
                    ).backgroundColor;  // returns 'rgb(r,g,b)'
                },

                getBackground() {
                    return window.getComputedStyle(
                        document.querySelector('.back.info.handle')
                    ).backgroundColor;
                },

                swap() {
                    document.querySelector('.swapcolors')?.onClick?.();
                }
            };


            // ─── 3. BRUSH ────────────────────────────────────────────────────────

            // Reads/writes the range sliders in the Brush panel
            function getBrushSlider(labelText) {
                const labels = document.querySelectorAll('label');
                for (const lbl of labels) {
                    if (lbl.textContent.trim() === labelText) {
                        return lbl.closest('.rangeselect')?.querySelector('input[type=range]');
                    }
                }
                return null;
            }

            function setBrushSlider(labelText, value) {
                const inp = getBrushSlider(labelText);
                if (!inp) return false;
                inp.value = String(value);
                inp.dispatchEvent(new Event('input',  { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }

            const brush = {
                setSize(v)     { return setBrushSlider('Size', v);     },  // 1–100
                setSoftness(v) { return setBrushSlider('Softness', v); },  // 0–10
                setOpacity(v)  { return setBrushSlider('Opacity', v);  },  // 1–100
                setFlow(v)     { return setBrushSlider('Flow', v);     },  // 1–100
                setJitter(v)   { return setBrushSlider('Jitter', v);   },  // 0–100
                setRotation(v) { return setBrushSlider('Rotation', v); },  // 0–100

                getSize()      { return Number(getBrushSlider('Size')?.value);     },
                getOpacity()   { return Number(getBrushSlider('Opacity')?.value);  },

                // Apply a named preset in one call
                preset(name) {
                    const presets = {
                        hard:  { size: 8,  softness: 0,  opacity: 100, flow: 100 },
                        soft:  { size: 20, softness: 8,  opacity: 80,  flow: 60  },
                        spray: { size: 30, softness: 5,  opacity: 60,  flow: 40, jitter: 80 },
                        erase: { size: 12, softness: 3,  opacity: 100, flow: 100 },
                    };
                    const p = presets[name];
                    if (!p) return false;
                    Object.entries(p).forEach(([k, v]) => brush['set' + k[0].toUpperCase() + k.slice(1)]?.(v));
                    return true;
                }
            };


            // ─── 4. LAYERS ───────────────────────────────────────────────────────

            const layers = {
                getAll() {
                    return getActiveFrame()?.layers ?? [];
                },

                getActive() {
                    return getActiveLayer();
                },

                getCount() {
                    return this.getAll().length;
                },

                // Add a new layer (via Layer > New menu)
                addNew() {
                    return triggerMenuItem('New');   // scoped to Layer submenu
                },

                duplicate() {
                    return triggerMenuItem('Duplicate');
                },

                mergeDown() {
                    return triggerMenuItem('Merge Down');
                },

                // Select a layer by index (0 = bottom)
                selectByIndex(index) {
                    const frame = getActiveFrame();
                    if (!frame || index >= frame.layers.length) return false;
                    frame.activeLayerIndex = index;
                    // Sync the UI layer panel
                    const layerEls = document.querySelectorAll('.layer.info.handle');
                    layerEls.forEach(el => {
                        if (el.targetIndex === index) el.onClick?.(new MouseEvent('click'));
                    });
                    return true;
                },

                // Set opacity on the active layer's slider (0–100)
                setOpacity(value) {
                    const inp = document.querySelector('.rangeselect.info input[type=range]');
                    if (!inp) return false;
                    inp.value = String(value);
                    inp.dispatchEvent(new Event('input',  { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                },

                openEffects() {
                    return triggerMenuItem('Effects');
                }
            };


            // ─── 5. CANVAS / DRAWING ─────────────────────────────────────────────

            const canvas = {
                // Get the raw HTMLCanvasElement for the active layer
                getElement() {
                    return getActiveLayer()?.getCanvas();
                },

                // Get the 2D context for direct drawing
                getContext() {
                    return getActiveLayer()?.getContext();
                },

                getWidth()  { return getCurrentFile()?.width;  },
                getHeight() { return getCurrentFile()?.height; },

                // Fill the active layer with a solid color
                fill(hex) {
                    const layer = getActiveLayer();
                    if (!layer) return false;
                    layer.fill(hex,true);
                    EventBus.trigger(EVENT.layerContentChanged);
                    return true;
                },

                // Clear the active layer to transparent
                clear() {
                    getActiveLayer()?.clear?.();
                },

                // Export current canvas as a PNG data URL
                toDataURL() {
                    return getActiveLayer()?.getCanvas()?.toDataURL('image/png');
                }
            };


            // ─── 6. HISTORY ──────────────────────────────────────────────────────

            const history = {
                undo() { triggerMenuItem('Undo'); },
                redo() { triggerMenuItem('Redo'); }
            };


            // ─── 7. IMAGE / FILE ─────────────────────────────────────────────────

            const image = {
                rotate()      { triggerMenuItem('Rotate');     },
                crop()        { triggerMenuItem('Crop');        },
                trim()        { triggerMenuItem('Trim');        },
                flatten()     { triggerMenuItem('Flatten');     },
                resize()      { triggerMenuItem('Image size');  },
                canvasSize()  { triggerMenuItem('Canvas Size'); },

                save()        { autoSave(); },

                getInfo() {
                    const f = getCurrentFile();
                    return { name: f?.name, width: f?.width, height: f?.height,
                        frameCount: f?.frames?.length, layerCount: layers.getCount() };
                }
            };


            // ─── 8. FRAMES / ANIMATION ───────────────────────────────────────────

            const frames = {
                getAll() { return getCurrentFile()?.frames ?? []; },
                getCount() { return this.getAll().length;  },

                setFPS(value) {
                    const inp = document.querySelector('.rangeselectinline input[type=range]');
                    if (!inp) return false;
                    inp.value = String(Math.min(60, Math.max(1, value)));
                    inp.dispatchEvent(new Event('input',  { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                },

                framesToLayers() { triggerMenuItem('Frames to Layers'); },
                layersToFrames() { triggerMenuItem('Layers to Frames'); }
            };


            // ─── 9. PALETTE ──────────────────────────────────────────────────────

            const palette = {
                // Switch to a named palette preset using the Reduce Colors dropdown
                loadPreset(name) {
                    // name matches option values: 'dpaint','pico8','db16','db32','spectrum','cga', etc.
                    const sel = document.querySelector('#reducecolors select, .subpanel select');
                    if (!sel) return false;
                    sel.value = name;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                },

                openEditor()  { triggerMenuItem('Edit');  },  // Palette > Edit
                fromImage()   { triggerMenuItem('From Image'); },
                toggleCycle() { triggerMenuItem('Toggle Color Cycle'); }
            };


            // ─── 10. SELECTION ───────────────────────────────────────────────────

            const selection = {
                selectAll()    { triggerMenuItem('All'); },
                deselect()     { triggerMenuItem('Deselect'); },
                invert()       { triggerMenuItem('Invert'); },
                copyToLayer()  { triggerMenuItem('Copy To Layer'); },
                cutToLayer()   { triggerMenuItem('Cut To Layer'); }
            };


            // ─── PUBLIC API ──────────────────────────────────────────────────────

            return {
                tools,
                color,
                brush,
                layers,
                canvas,
                history,
                image,
                frames,
                palette,
                selection,

                // Convenience: describe current state (useful for Claude to call first)
                getState() {
                    const layer = getActiveLayer();
                    return {
                        file:       image.getInfo(),
                        activeTool: tools.getActiveTool(),
                        fgColor:    color.getForeground(),
                        bgColor:    color.getBackground(),
                        brush: {
                            size:    brush.getSize(),
                            opacity: brush.getOpacity()
                        },
                        activeLayer: layer ? {
                            name:      layer.name,
                            opacity:   layer.opacity,
                            visible:   layer.visible,
                            blendMode: layer.blendMode
                        } : null
                    };
                }
            };

        })();
    }

    return me;
})();

export default ClientApi;