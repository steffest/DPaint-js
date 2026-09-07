import {$div, $checkbox, $input, $elm} from "../../util/dom.js";
import EventBus from "../../util/eventbus.js";
import {EVENT} from "../../enum.js";
import ImageFile from "../../image.js";
import VectorTool from "../../paintTools/vectorTool.js";

// "View as code" split-panel view (spec: code view for vector layers). Shows the ACTIVE vector
// layer's geometry as standalone SVG text in a plain text editor and keeps both sides in sync:
//   left  -> code : any geometry edit (vectorChanged / layer switch) re-renders the text, unless
//                   the user is currently typing in the editor.
//   code  -> left : typing is debounced, then written back with ImageFile.setActiveVectorFromSvg.
//                   Valid SVG updates the layer; invalid SVG leaves the layer untouched and raises
//                   the "Invalid SVG" warning above the editor.
// Syntax colouring + selection highlight are painted by a <pre> that sits directly behind a
// transparent <textarea>: the textarea stays the real, editable, caret-owning element while the
// coloured markup shows through. When the user selects a node/line/shape on the canvas, the
// <path> line(s) representing it are highlighted (see refreshHighlight / the line map).
// The round-trip itself (SVG <-> vector geometry) lives in image.js; this component is only the UI.
let CodeView = function(parent){
    let me = {};
    // Guards the vectorChanged/layersChanged listeners against the edits WE trigger while writing
    // the editor's text back to the layer, so a code->left change never bounces back and clobbers
    // the caret.
    let applyingFromCode = false;
    let debounceTimer;

    // Display options for the SVG text. These only affect how the geometry is SHOWN/round-tripped in
    // the editor, not the layer itself until the user edits the text.
    let wrapEnabled = false;
    // Max meaningful precision of a JS double is ~15-17 significant digits; DECIMALS_MAX is treated as
    // "no rounding" so the user can dial precision all the way back up to the raw output.
    const DECIMALS_MAX = 14;
    let decimals = 3;

    // path-line -> source mapping, rebuilt whenever the text is re-rendered from the layer.
    let lineMap = null;
    // set of 0-based line indexes currently highlighted for the canvas selection.
    let highlightedLines = new Set();

    let container = $div("codeView hidden","",parent);

    // Toolbar sits directly below the panel's E/I/T/<> view buttons and above the editor.
    let toolbar = $div("codeView-toolbar","",container);
    $checkbox("Line wrap",toolbar,"",(checked)=>{
        wrapEnabled = checked;
        applyWrap();
    },wrapEnabled);

    let decimalsGroup = $div("codeView-toolbar-group","",toolbar);
    $elm("label","Decimals",decimalsGroup);
    let decimalsInput = $input("number",decimals,decimalsGroup,()=>{
        let v = parseInt(decimalsInput.value,10);
        if (isNaN(v)) return;
        v = Math.max(0,Math.min(DECIMALS_MAX,v));
        decimals = v;
        // Re-render from the layer so the change is visible immediately, unless the user is mid-edit
        // in the textarea (their in-progress text would be clobbered).
        if (document.activeElement !== editor) me.refresh();
    });
    decimalsInput.min = 0;
    decimalsInput.max = DECIMALS_MAX;
    decimalsInput.step = 1;
    decimalsInput.onkeydown = (e)=>{ e.stopPropagation(); };

    let warning = $div("codeView-warning hidden","",container);
    $div("codeView-warning-icon","!",warning);
    $div("codeView-warning-label","Invalid SVG",warning);

    // The editor stack: a coloured (read-only, aria-hidden) <pre> behind a transparent <textarea>.
    let inputWrap = $div("codeView-input","",container);
    let highlight = document.createElement("pre");
    highlight.className = "codeView-highlight";
    highlight.setAttribute("aria-hidden","true");
    let code = document.createElement("code");
    highlight.appendChild(code);
    inputWrap.appendChild(highlight);

    let editor = document.createElement("textarea");
    editor.className = "codeView-editor";
    editor.spellcheck = false;
    editor.setAttribute("autocomplete","off");
    editor.setAttribute("autocorrect","off");
    editor.setAttribute("autocapitalize","off");
    inputWrap.appendChild(editor);
    applyWrap();

    // Keep keystrokes inside the editor: without this the global key handler treats them as canvas
    // shortcuts (e.g. Delete -> CLEAR, letters -> tool switches), which both eats the typing and
    // crashes on a vector layer (no raster context to snapshot). Same convention as the app's other
    // text fields/textareas.
    editor.onkeydown = (e)=>{ e.stopPropagation(); };

    editor.addEventListener("input",()=>{
        // The text no longer matches the layer, so the selection line map is stale: drop the
        // highlight until the next refresh rebuilds it.
        highlightedLines = new Set();
        renderHighlight();
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(applyToLayer,300);
    });
    editor.addEventListener("scroll",syncScroll);

    function syncScroll(){
        highlight.scrollTop = editor.scrollTop;
        highlight.scrollLeft = editor.scrollLeft;
    }

    function applyToLayer(){
        applyingFromCode = true;
        let ok = ImageFile.setActiveVectorFromSvg(editor.value);
        applyingFromCode = false;
        warning.classList.toggle("hidden",ok);
    }

    function applyWrap(){
        editor.setAttribute("wrap",wrapEnabled ? "soft" : "off");
        editor.classList.toggle("wrap",wrapEnabled);
        highlight.classList.toggle("wrap",wrapEnabled);
    }

    function roundNumbers(str){
        return str.replace(/-?\d*\.\d+(?:[eE][-+]?\d+)?/g,(match)=>{
            let n = parseFloat(match);
            if (isNaN(n)) return match;
            let rounded = n.toFixed(decimals);
            if (rounded.indexOf(".") >= 0) rounded = rounded.replace(/0+$/,"").replace(/\.$/,"");
            return rounded;
        });
    }

    // Round the floating-point numbers in the SVG's GEOMETRY to the configured number of decimals,
    // dropping trailing zeros so the output stays compact. Scoped to path data (`d="…"`) and
    // stroke widths only: rounding every number in the document would also mangle non-coordinate
    // values like the XML declaration's version="1.0" (-> "1"), producing SVG that no longer parses.
    // DECIMALS_MAX means "leave as-is".
    function limitDecimals(text){
        if (decimals >= DECIMALS_MAX) return text;
        return text.replace(/\b(d|stroke-width)="([^"]*)"/g,(m,attr,body)=>{
            return attr + '="' + roundNumbers(body) + '"';
        });
    }

    // ── syntax highlighting ─────────────────────────────────────────────────────────
    function escapeHtml(s){
        return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }

    function highlightAttrs(attrs){
        return attrs.replace(/([\w:.-]+)(\s*=\s*)("[^"]*"|'[^']*')/g,(m,name,eq,val)=>{
            return '<span class="tok-attr">'+name+'</span>'+eq+'<span class="tok-value">'+val+'</span>';
        });
    }

    // Colour one line of SVG/XML. Operates per-line (our generated SVG has one element per line);
    // arbitrary user text still colours safely, at worst losing colour across a hand-split tag.
    function highlightSvgLine(line){
        let esc = escapeHtml(line);
        esc = esc.replace(/(&lt;!--[\s\S]*?--&gt;)/g,'<span class="tok-comment">$1</span>');
        esc = esc.replace(/(&lt;\?[\s\S]*?\?&gt;)/g,'<span class="tok-decl">$1</span>');
        esc = esc.replace(/(&lt;\/?)([\w:.-]+)((?:[^&]|&(?!gt;))*?)(\/?&gt;)/g,(m,open,name,attrs,close)=>{
            return '<span class="tok-punct">'+open+'</span><span class="tok-tag">'+name+'</span>'
                + highlightAttrs(attrs)
                + '<span class="tok-punct">'+close+'</span>';
        });
        return esc;
    }

    function renderHighlight(){
        let out = editor.value.split("\n").map((line,i)=>{
            let h = highlightSvgLine(line);
            if (highlightedLines.has(i)) return '<span class="codeView-hl">'+h+'</span>';
            return h;
        }).join("\n");
        // Trailing newline so the <pre> reserves the same final blank line the textarea does.
        code.innerHTML = out + "\n";
        syncScroll();
    }

    // ── selection -> line mapping ────────────────────────────────────────────────────
    // The Nth <path> line in the text is produced by the Nth shape source (regions first, then
    // stroked edges — see getVectorSvgShapeSources), so index alignment is enough; no coordinate
    // matching required.
    function buildLineMap(text, sources){
        let lines = text.split("\n");
        let pathLines = [];
        lines.forEach((ln,i)=>{ if (/^\s*<path\b/.test(ln)) pathLines.push(i); });
        let edgeMap = {}, nodeMap = {}, regionMap = {};
        sources.forEach((src,k)=>{
            let li = pathLines[k];
            if (li == null) return;
            if (src.kind === "region") regionMap[src.id] = li;
            (src.edgeIds || []).forEach(e=>{ (edgeMap[e] = edgeMap[e] || []).push(li); });
            (src.nodeIds || []).forEach(n=>{ (nodeMap[n] = nodeMap[n] || []).push(li); });
        });
        return { edgeMap, nodeMap, regionMap };
    }

    // Resolve the current canvas selection to a set of highlighted path-line indexes.
    function computeHighlightedLines(){
        highlightedLines = new Set();
        if (!lineMap) return;

        let edges = new Set(), nodes = new Set(), regions = new Set();
        let sel = VectorTool.getSelection ? VectorTool.getSelection() : null;
        if (sel){
            if (sel.edgeId) edges.add(sel.edgeId);
            if (sel.regionId) regions.add(sel.regionId);
            if (sel.nodeId) nodes.add(sel.nodeId);
            if (sel.handle && sel.handle.edgeId) edges.add(sel.handle.edgeId);
        }
        // Multi-line selection is only surfaced through getSelectionInfo (comma-joined edge ids).
        let info = VectorTool.getSelectionInfo ? VectorTool.getSelectionInfo() : null;
        if (info && info.kind === "edge" && info.id != null){
            String(info.id).split(",").forEach(e=>{ e = e.trim(); if (e) edges.add(e); });
        }
        (VectorTool.getSelectedNodes ? VectorTool.getSelectedNodes() : []).forEach(n=>nodes.add(n));

        regions.forEach(r=>{ if (lineMap.regionMap[r] != null) highlightedLines.add(lineMap.regionMap[r]); });
        edges.forEach(e=>{ (lineMap.edgeMap[e] || []).forEach(i=>highlightedLines.add(i)); });
        nodes.forEach(n=>{ (lineMap.nodeMap[n] || []).forEach(i=>highlightedLines.add(i)); });
    }

    // Re-render the editor text from the active vector layer. No-op when the active layer is not a
    // vector layer (the panel is switched away from code view in that case, see editpanel.js).
    me.refresh = function(){
        let svg = ImageFile.getActiveVectorSvg();
        if (svg == null) return;
        let text = limitDecimals(svg);
        editor.value = text;
        warning.classList.add("hidden");
        lineMap = buildLineMap(text, ImageFile.getActiveVectorShapeSources ? ImageFile.getActiveVectorShapeSources() : []);
        computeHighlightedLines();
        renderHighlight();
    };

    me.getElement = function(){ return container; };

    me.show = function(){
        container.classList.remove("hidden");
        me.refresh();
    };

    me.hide = function(){
        clearTimeout(debounceTimer);
        container.classList.add("hidden");
    };

    function isVisible(){ return !container.classList.contains("hidden"); }

    // A left-side geometry edit, a selection change, or a layer switch. Selection changes reuse
    // EVENT.vectorChanged, so re-render (which also recomputes the selection highlight); but never
    // while the user is typing here (that edit is flowing the other way, and the text/map is mid-
    // change) or while we are applying our own edit.
    function syncFromLayer(){
        if (applyingFromCode || !isVisible()) return;
        if (document.activeElement === editor) return;
        me.refresh();
    }

    EventBus.on(EVENT.vectorChanged,syncFromLayer);
    EventBus.on(EVENT.layersChanged,syncFromLayer);

    return me;
};

export default CodeView;
