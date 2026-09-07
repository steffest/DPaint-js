import {getVectorSvgShapes, emptyVectorData, addNode, addEdge, newRegionId} from "../util/vectorUtils.js";

const SVGNS = "http://www.w3.org/2000/svg";
const XLINKNS = "http://www.w3.org/1999/xlink";
// bezier arc constant — a quarter ellipse as one cubic (mirrors vectorTool.buildEllipse)
const KAPPA = 0.5522847498307936;

let SVG = function(){
    let me = {};

    // ── EXPORT ──────────────────────────────────────────────────────────────────────

    me.write = function(model, width, height){
        let lines = [];
        lines.push('<?xml version="1.0" encoding="UTF-8"?>');
        lines.push('<svg xmlns="' + SVGNS + '" xmlns:xlink="' + XLINKNS + '" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">');
        (model || []).forEach(op=>emit(op, lines, "  "));
        lines.push('</svg>');
        return lines.join("\n");
    };

    // The offset/opacity/blend attributes shared by every wrapper element.
    function containerAttrs(op){
        let a = "";
        if (op.x || op.y) a += ' transform="translate(' + op.x + ' ' + op.y + ')"';
        if (typeof op.opacity === "number" && op.opacity < 1) a += ' opacity="' + op.opacity + '"';
        if (op.blend && op.blend !== "normal") a += ' style="mix-blend-mode:' + op.blend + '"';
        return a;
    }

    function emit(op, lines, indent){
        switch (op.kind){
            case "group":
                lines.push(indent + "<g" + containerAttrs(op) + ">");
                (op.children || []).forEach(child=>emit(child, lines, indent + "  "));
                lines.push(indent + "</g>");
                break;
            case "image":
                lines.push(indent + '<image' + containerAttrs(op) + ' width="' + op.width + '" height="' + op.height + '" xlink:href="' + op.dataUrl + '"/>');
                break;
            case "vector":
                let shapes = getVectorSvgShapes(op.vector);
                if (!shapes.length) break;
                lines.push(indent + "<g" + containerAttrs(op) + ">");
                shapes.forEach(shape=>lines.push(indent + "  " + pathElement(shape)));
                lines.push(indent + "</g>");
                break;
        }
    }

    // One <path> — a fill, a stroke, or both — matching canvas.js drawVectorShapes. A combined
    // fill+stroke path (a filled shape with a uniform outline) is written as a single element so it
    // re-imports as one shape (its fill stays bound to its outline) rather than splitting apart.
    function pathElement(shape){
        if (shape.fill){
            let rule = (shape.fillRule && shape.fillRule !== "nonzero") ? ' fill-rule="' + shape.fillRule + '"' : "";
            if (shape.stroke){
                return '<path d="' + shape.d + '" fill="' + shape.fill + '"' + rule + ' stroke="' + shape.stroke + '" stroke-width="' + shape.width + '" stroke-linecap="round" stroke-linejoin="round"/>';
            }
            return '<path d="' + shape.d + '" fill="' + shape.fill + '"' + rule + '/>';
        }
        return '<path d="' + shape.d + '" fill="none" stroke="' + shape.stroke + '" stroke-width="' + shape.width + '" stroke-linecap="round" stroke-linejoin="round"/>';
    }

    // ── IMPORT ──────────────────────────────────────────────────────────────────────

    // Parse SVG text into { width, height, layers:[…] } layer specs (bottom-to-top):
    //   { kind:"vector", name, opacity, blend, vector }
    //   { kind:"image",  name, opacity, blend, x, y, width, height, dataUrl }
    // Throws on a malformed document.
    me.parse = function(svgText){
        let doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
        if (doc.querySelector("parsererror")) throw new Error("Invalid SVG");
        let svg = doc.documentElement;
        if (!svg || svg.tagName.toLowerCase() !== "svg") throw new Error("Not an SVG document");

        let gradients = collectGradientColors(svg);
        let root = rootTransform(svg);
        let W = root.width, H = root.height, rootMatrix = root.matrix;

        let layers = [];
        let acc = null;                 // running vector accumulator
        let accMeta = null;             // opacity/blend/name for the current vector run
        function flush(){
            if (acc && hasContent(acc)){
                layers.push({kind:"vector", name: accMeta.name || "Vector", opacity: accMeta.opacity, blend: accMeta.blend, vector: acc});
            }
            acc = null; accMeta = null;
        }

        let rootPaint = {fill:"#000000", stroke:null, strokeWidth:1, fillRule:"nonzero"};
        for (let child of Array.from(svg.children)){
            let tag = child.tagName.toLowerCase();
            if (SKIP_TAGS[tag]) continue;
            if (isHidden(child)) continue;
            if (tag === "image"){
                flush();
                let spec = imageSpec(child, rootMatrix);
                if (spec) layers.push(spec);
                continue;
            }
            // shape or <g>: flatten its geometry into the current vector accumulator
            if (!acc){
                acc = emptyVectorData();
                acc.displayMode = "vector";
                accMeta = {name: child.getAttribute("id") || null, opacity: opacityOf(child), blend: blendOf(child)};
            }
            walk(acc, child, rootMatrix, rootPaint, gradients);
        }
        flush();

        // No declared size → fall back to the produced content's bounding box.
        if (!W || !H){
            let bb = contentBounds(layers);
            W = W || Math.max(1, Math.ceil(bb.width));
            H = H || Math.max(1, Math.ceil(bb.height));
        }
        return {width: W, height: H, layers: layers};
    };

    const SKIP_TAGS = {defs:1, title:1, desc:1, style:1, metadata:1, symbol:1, marker:1, "clippath":1, mask:1, filter:1, lineargradient:1, radialgradient:1};

    function isHidden(el){
        return getProp(el,"display") === "none" || getProp(el,"visibility") === "hidden";
    }

    function opacityOf(el){
        let o = getProp(el,"opacity");
        if (o == null) return 1;
        let v = parseFloat(o);
        return isNaN(v) ? 1 : Math.max(0, Math.min(1, v));
    }
    function blendOf(el){
        let b = getProp(el,"mix-blend-mode");
        return b || "normal";
    }

    // Recursively add an element subtree's geometry into vector doc v, accumulating transform+paint.
    function walk(v, el, matrix, paint, gradients){
        if (isHidden(el)) return;
        let m = matMul(matrix, parseTransform(el.getAttribute("transform")));
        let p = parsePaint(el, paint, gradients);
        let tag = el.tagName.toLowerCase();
        switch (tag){
            case "g": case "a": case "svg":
                for (let child of Array.from(el.children)){
                    if (!SKIP_TAGS[child.tagName.toLowerCase()]) walk(v, child, m, p, gradients);
                }
                return;
            case "path": {
                let d = el.getAttribute("d");
                if (d) emitSubpaths(v, parsePath(d), m, p);
                return;
            }
            case "rect": {
                let x = num(el,"x"), y = num(el,"y"), w = num(el,"width"), h = num(el,"height");
                if (w <= 0 || h <= 0) return;
                emitSubpaths(v, [{start:{x:x,y:y}, segs:[
                    {type:"L",to:{x:x+w,y:y}}, {type:"L",to:{x:x+w,y:y+h}}, {type:"L",to:{x:x,y:y+h}}
                ], closed:true}], m, p);
                return;
            }
            case "circle": {
                let cx = num(el,"cx"), cy = num(el,"cy"), r = num(el,"r");
                if (r <= 0) return;
                emitSubpaths(v, [ellipseSubpath(cx,cy,r,r)], m, p);
                return;
            }
            case "ellipse": {
                let cx = num(el,"cx"), cy = num(el,"cy"), rx = num(el,"rx"), ry = num(el,"ry");
                if (rx <= 0 || ry <= 0) return;
                emitSubpaths(v, [ellipseSubpath(cx,cy,rx,ry)], m, p);
                return;
            }
            case "line": {
                let x1 = num(el,"x1"), y1 = num(el,"y1"), x2 = num(el,"x2"), y2 = num(el,"y2");
                emitSubpaths(v, [{start:{x:x1,y:y1}, segs:[{type:"L",to:{x:x2,y:y2}}], closed:false}], m, p);
                return;
            }
            case "polyline": case "polygon": {
                let pts = parsePoints(el.getAttribute("points"));
                if (pts.length < 2) return;
                let segs = pts.slice(1).map(pt=>({type:"L", to:pt}));
                emitSubpaths(v, [{start:pts[0], segs:segs, closed: tag === "polygon"}], m, p);
                return;
            }
            // text/use/image-in-group and anything else: skipped (documented)
        }
    }

    // A quarter-ellipse-per-cubic subpath (closed), mirroring vectorTool.buildEllipse.
    function ellipseSubpath(cx, cy, rx, ry){
        return {start:{x:cx+rx,y:cy}, closed:true, segs:[
            {type:"C", c1:{x:cx+rx,y:cy+ry*KAPPA}, c2:{x:cx+rx*KAPPA,y:cy+ry}, to:{x:cx,y:cy+ry}},
            {type:"C", c1:{x:cx-rx*KAPPA,y:cy+ry}, c2:{x:cx-rx,y:cy+ry*KAPPA}, to:{x:cx-rx,y:cy}},
            {type:"C", c1:{x:cx-rx,y:cy-ry*KAPPA}, c2:{x:cx-rx*KAPPA,y:cy-ry}, to:{x:cx,y:cy-ry}},
            {type:"C", c1:{x:cx+rx*KAPPA,y:cy-ry}, c2:{x:cx+rx,y:cy-ry*KAPPA}, to:{x:cx+rx,y:cy}}
        ]};
    }

    // Build nodes/edges/regions for the subpaths of ONE element, baking the matrix into every
    // point. All closed subpaths of a filled element become a single compound region (first loop =
    // boundary, the rest = holes) rendered under the element's fill-rule — so an evenodd path's
    // inner subpaths cut holes instead of each filling solid. Strokes stay per-edge.
    //
    // A filled element implicitly closes each subpath for fill purposes (SVG fill spec), even
    // without an explicit Z — so a path whose subpaths return to their start but omit Z (e.g. many
    // exported icons) still fills. Stroking does NOT implicitly close, so an implicit fill-close
    // edge is added without a stroke; only an explicit Z carries the stroke around it.
    function emitSubpaths(v, subpaths, matrix, paint){
        let scale = Math.sqrt(Math.abs(matrix[0]*matrix[3] - matrix[1]*matrix[2])) || 1;
        let stroke = paint.stroke ? {color: paint.stroke, width: (paint.strokeWidth || 1) * scale, smooth: false} : null;
        let loops = [];
        subpaths.forEach(sp=>{
            if (!sp.segs.length) return;
            let fillClose = sp.closed || !!paint.fill;   // treat as a closed loop for fill
            let startP = apply(matrix, sp.start);
            let firstNode = addNode(v, startP.x, startP.y);
            let prevNode = firstNode;
            let edgeIds = [];
            sp.segs.forEach((seg, i)=>{
                let toP = apply(matrix, seg.to);
                let last = i === sp.segs.length - 1;
                let closesToStart = fillClose && last && dist(toP, startP) < 1e-6;
                let toNode = closesToStart ? firstNode : addNode(v, toP.x, toP.y);
                let opts = {stroke: stroke};
                if (seg.type === "C") opts.curve = {h1: apply(matrix, seg.c1), h2: apply(matrix, seg.c2)};
                edgeIds.push(addEdge(v, prevNode.id, toNode.id, opts).id);
                prevNode = toNode;
            });
            if (fillClose && prevNode.id !== firstNode.id){
                edgeIds.push(addEdge(v, prevNode.id, firstNode.id, {stroke: sp.closed ? stroke : null}).id);
            }
            if (fillClose && edgeIds.length >= 2) loops.push(edgeIds);
        });
        if (paint.fill && loops.length){
            let id = newRegionId(v);
            v.regions[id] = {
                id: id,
                boundary: loops[0],
                holes: loops.slice(1),
                fillRule: paint.fillRule || "nonzero",
                fill: {color: paint.fill, smooth: false}
            };
        }
    }

    function hasContent(v){
        return Object.keys(v.edges).length > 0 || Object.keys(v.regions).length > 0;
    }

    // ── path `d` parsing ──────────────────────────────────────────────────────────────

    function parsePath(d){
        let toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
        let i = 0, subpaths = [], cur = null;
        let cx = 0, cy = 0, sx = 0, sy = 0, prevCtrl = null, prevCmd = null;
        function n(){ return parseFloat(toks[i++]); }
        function ensure(){ if (!cur){ cur = {start:{x:cx,y:cy}, segs:[], closed:false}; subpaths.push(cur); sx = cx; sy = cy; } }
        while (i < toks.length){
            let t = toks[i], cmd;
            if (/[a-zA-Z]/.test(t)){ cmd = t; i++; }
            else { if (!prevCmd) { i++; continue; } cmd = prevCmd; }
            let rel = cmd === cmd.toLowerCase();
            let C = cmd.toUpperCase();
            switch (C){
                case "M": {
                    let x = n(), y = n(); if (rel){ x += cx; y += cy; }
                    cx = x; cy = y; cur = {start:{x:x,y:y}, segs:[], closed:false}; subpaths.push(cur);
                    sx = x; sy = y; prevCtrl = null; prevCmd = rel ? "l" : "L"; break;
                }
                case "L": { let x = n(), y = n(); if (rel){ x += cx; y += cy; } ensure(); cur.segs.push({type:"L",to:{x:x,y:y}}); cx = x; cy = y; prevCtrl = null; prevCmd = cmd; break; }
                case "H": { let x = n(); if (rel) x += cx; ensure(); cur.segs.push({type:"L",to:{x:x,y:cy}}); cx = x; prevCtrl = null; prevCmd = cmd; break; }
                case "V": { let y = n(); if (rel) y += cy; ensure(); cur.segs.push({type:"L",to:{x:cx,y:y}}); cy = y; prevCtrl = null; prevCmd = cmd; break; }
                case "C": {
                    let c1x = n(), c1y = n(), c2x = n(), c2y = n(), x = n(), y = n();
                    if (rel){ c1x += cx; c1y += cy; c2x += cx; c2y += cy; x += cx; y += cy; }
                    ensure(); cur.segs.push({type:"C", c1:{x:c1x,y:c1y}, c2:{x:c2x,y:c2y}, to:{x:x,y:y}});
                    prevCtrl = {x:c2x,y:c2y}; cx = x; cy = y; prevCmd = cmd; break;
                }
                case "S": {
                    let c2x = n(), c2y = n(), x = n(), y = n();
                    if (rel){ c2x += cx; c2y += cy; x += cx; y += cy; }
                    let c1 = (prevCmd && /[CS]/i.test(prevCmd) && prevCtrl) ? {x:2*cx-prevCtrl.x, y:2*cy-prevCtrl.y} : {x:cx,y:cy};
                    ensure(); cur.segs.push({type:"C", c1:c1, c2:{x:c2x,y:c2y}, to:{x:x,y:y}});
                    prevCtrl = {x:c2x,y:c2y}; cx = x; cy = y; prevCmd = cmd; break;
                }
                case "Q": {
                    let qx = n(), qy = n(), x = n(), y = n();
                    if (rel){ qx += cx; qy += cy; x += cx; y += cy; }
                    ensure(); cur.segs.push(quadToCubic(cx, cy, qx, qy, x, y));
                    prevCtrl = {x:qx,y:qy}; cx = x; cy = y; prevCmd = cmd; break;
                }
                case "T": {
                    let x = n(), y = n(); if (rel){ x += cx; y += cy; }
                    let q = (prevCmd && /[QT]/i.test(prevCmd) && prevCtrl) ? {x:2*cx-prevCtrl.x, y:2*cy-prevCtrl.y} : {x:cx,y:cy};
                    ensure(); cur.segs.push(quadToCubic(cx, cy, q.x, q.y, x, y));
                    prevCtrl = q; cx = x; cy = y; prevCmd = cmd; break;
                }
                case "A": {
                    let rx = n(), ry = n(), rot = n(), laf = n(), sf = n(), x = n(), y = n();
                    if (rel){ x += cx; y += cy; }
                    ensure();
                    arcToCubics(cx, cy, rx, ry, rot, laf, sf, x, y).forEach(c=>cur.segs.push({type:"C", c1:c.c1, c2:c.c2, to:c.to}));
                    prevCtrl = null; cx = x; cy = y; prevCmd = cmd; break;
                }
                case "Z": { if (cur) cur.closed = true; cx = sx; cy = sy; prevCtrl = null; prevCmd = cmd; break; }
                default: i++;
            }
        }
        return subpaths;
    }

    function quadToCubic(px, py, qx, qy, x, y){
        return {type:"C",
            c1:{x: px + 2/3*(qx-px), y: py + 2/3*(qy-py)},
            c2:{x: x + 2/3*(qx-x),  y: y + 2/3*(qy-y)},
            to:{x:x,y:y}};
    }

    // Elliptical arc → one or more cubics (endpoint parameterization, ≤90° per segment).
    function arcToCubics(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2){
        if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [{c1:{x:x1,y:y1}, c2:{x:x2,y:y2}, to:{x:x2,y:y2}}];
        rx = Math.abs(rx); ry = Math.abs(ry);
        let phi = phiDeg * Math.PI / 180, cosP = Math.cos(phi), sinP = Math.sin(phi);
        let dx = (x1-x2)/2, dy = (y1-y2)/2;
        let x1p = cosP*dx + sinP*dy, y1p = -sinP*dx + cosP*dy;
        let lambda = (x1p*x1p)/(rx*rx) + (y1p*y1p)/(ry*ry);
        if (lambda > 1){ let s = Math.sqrt(lambda); rx *= s; ry *= s; }
        let sign = (fa !== fs) ? 1 : -1;
        let num = rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p;
        let den = rx*rx*y1p*y1p + ry*ry*x1p*x1p;
        let co = sign * Math.sqrt(Math.max(0, num/den));
        let cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
        let cx = cosP*cxp - sinP*cyp + (x1+x2)/2;
        let cy = sinP*cxp + cosP*cyp + (y1+y2)/2;
        let angle = (ux, uy, vx, vy)=>{
            let d = Math.sqrt((ux*ux+uy*uy)*(vx*vx+vy*vy));
            let c = d ? (ux*vx+uy*vy)/d : 1;
            c = Math.max(-1, Math.min(1, c));
            let a = Math.acos(c);
            return (ux*vy - uy*vx < 0) ? -a : a;
        };
        let theta1 = angle(1, 0, (x1p-cxp)/rx, (y1p-cyp)/ry);
        let dtheta = angle((x1p-cxp)/rx, (y1p-cyp)/ry, (-x1p-cxp)/rx, (-y1p-cyp)/ry);
        if (!fs && dtheta > 0) dtheta -= 2*Math.PI;
        if (fs && dtheta < 0) dtheta += 2*Math.PI;
        let segsN = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI/2)));
        let delta = dtheta / segsN, alpha = 4/3 * Math.tan(delta/4);
        let pointAt = th=>({x: cx + rx*Math.cos(th)*cosP - ry*Math.sin(th)*sinP, y: cy + rx*Math.cos(th)*sinP + ry*Math.sin(th)*cosP});
        let derivAt = th=>({x: -rx*Math.sin(th)*cosP - ry*Math.cos(th)*sinP, y: -rx*Math.sin(th)*sinP + ry*Math.cos(th)*cosP});
        let out = [], th = theta1;
        for (let k = 0; k < segsN; k++){
            let th2 = th + delta;
            let p1 = pointAt(th), p2 = pointAt(th2), d1 = derivAt(th), d2 = derivAt(th2);
            out.push({c1:{x:p1.x+alpha*d1.x, y:p1.y+alpha*d1.y}, c2:{x:p2.x-alpha*d2.x, y:p2.y-alpha*d2.y}, to:{x:p2.x, y:p2.y}});
            th = th2;
        }
        return out;
    }

    // ── attributes, transforms, colour ────────────────────────────────────────────────

    function num(el, name){ let v = parseFloat(el.getAttribute(name)); return isNaN(v) ? 0 : v; }

    function parsePoints(str){
        if (!str) return [];
        let nums = (str.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
        let pts = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push({x:nums[i], y:nums[i+1]});
        return pts;
    }

    // Inline style wins over presentation attribute.
    function getProp(el, name){
        let style = el.getAttribute && el.getAttribute("style");
        if (style){
            let m = style.match(new RegExp("(?:^|;)\\s*" + name + "\\s*:\\s*([^;]+)"));
            if (m) return m[1].trim();
        }
        let a = el.getAttribute && el.getAttribute(name);
        return (a != null) ? a.trim() : null;
    }

    function parsePaint(el, parent, gradients){
        let f = getProp(el, "fill");
        let s = getProp(el, "stroke");
        let w = getProp(el, "stroke-width");
        let fr = getProp(el, "fill-rule");
        return {
            fill: (f != null) ? resolveColor(f, gradients) : parent.fill,
            stroke: (s != null) ? resolveColor(s, gradients) : parent.stroke,
            strokeWidth: (w != null && !isNaN(parseFloat(w))) ? parseFloat(w) : parent.strokeWidth,
            fillRule: (fr === "evenodd" || fr === "nonzero") ? fr : parent.fillRule
        };
    }

    let _ctx = null;
    function colorCtx(){
        if (!_ctx){ let c = document.createElement("canvas"); c.width = c.height = 1; _ctx = c.getContext("2d"); }
        return _ctx;
    }
    function resolveColor(str, gradients){
        if (!str) return null;
        str = str.trim();
        if (str === "none" || str === "transparent") return null;
        if (str === "currentColor" || str === "inherit") return "#000000";
        let url = str.match(/^url\(['"]?#([^'")]+)['"]?\)/);
        if (url) return (gradients && gradients[url[1]]) || "#000000";
        let ctx = colorCtx();
        ctx.fillStyle = "#000000";
        try { ctx.fillStyle = str; } catch (e){ return "#000000"; }
        let r = ctx.fillStyle;
        if (r[0] === "#") return r;
        let m = r.match(/rgba?\(([^)]+)\)/);
        if (m){ let p = m[1].split(",").map(parseFloat); return rgbToHex(p[0], p[1], p[2]); }
        return r;
    }
    function rgbToHex(r, g, b){ return "#" + [r,g,b].map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,"0")).join(""); }

    // First stop-color of every gradient, keyed by id (solid fallback for url(#…) paints).
    function collectGradientColors(svg){
        let map = {};
        svg.querySelectorAll("linearGradient,radialGradient").forEach(g=>{
            let id = g.getAttribute("id");
            if (!id) return;
            let stop = g.querySelector("stop");
            let c = stop ? (getProp(stop, "stop-color") || "#000000") : "#000000";
            map[id] = resolveColor(c, null);
        });
        return map;
    }

    // ── matrix (2×3 [a,b,c,d,e,f]) ──────────────────────────────────────────────────────

    function matId(){ return [1,0,0,1,0,0]; }
    function matMul(m, n){
        return [
            m[0]*n[0] + m[2]*n[1],
            m[1]*n[0] + m[3]*n[1],
            m[0]*n[2] + m[2]*n[3],
            m[1]*n[2] + m[3]*n[3],
            m[0]*n[4] + m[2]*n[5] + m[4],
            m[1]*n[4] + m[3]*n[5] + m[5]
        ];
    }
    function apply(m, p){ return {x: m[0]*p.x + m[2]*p.y + m[4], y: m[1]*p.x + m[3]*p.y + m[5]}; }
    function dist(a, b){ return Math.hypot(a.x-b.x, a.y-b.y); }

    function parseTransform(str){
        let m = matId();
        if (!str) return m;
        let re = /(\w+)\s*\(([^)]*)\)/g, match;
        while ((match = re.exec(str))){
            let name = match[1], a = (match[2].match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
            let t;
            switch (name){
                case "translate": t = [1,0,0,1, a[0]||0, a[1]||0]; break;
                case "scale": t = [a[0]||0,0,0, (a.length>1?a[1]:a[0])||0, 0,0]; break;
                case "rotate": {
                    let r = (a[0]||0)*Math.PI/180, c = Math.cos(r), s = Math.sin(r);
                    let rm = [c,s,-s,c,0,0];
                    if (a.length >= 3) rm = matMul(matMul([1,0,0,1,a[1],a[2]], rm), [1,0,0,1,-a[1],-a[2]]);
                    t = rm; break;
                }
                case "matrix": t = [a[0],a[1],a[2],a[3],a[4],a[5]]; break;
                case "skewX": t = [1,0,Math.tan((a[0]||0)*Math.PI/180),1,0,0]; break;
                case "skewY": t = [1,Math.tan((a[0]||0)*Math.PI/180),0,1,0,0]; break;
                default: t = matId();
            }
            m = matMul(m, t);
        }
        return m;
    }

    // Document size + the viewBox→width/height mapping baked as the root matrix.
    function rootTransform(svg){
        let W = parseLen(svg.getAttribute("width"));
        let H = parseLen(svg.getAttribute("height"));
        let vb = svg.getAttribute("viewBox");
        if (vb){
            let p = vb.split(/[\s,]+/).map(Number).filter(v=>!isNaN(v));
            if (p.length === 4){
                let [minx, miny, vbw, vbh] = p;
                let ww = W || vbw, hh = H || vbh;
                let sx = vbw ? ww/vbw : 1, sy = vbh ? hh/vbh : 1;
                return {width: ww, height: hh, matrix: matMul([sx,0,0,sy,0,0], [1,0,0,1,-minx,-miny])};
            }
        }
        return {width: W, height: H, matrix: matId()};
    }
    function parseLen(str){
        if (!str) return null;
        if (str.indexOf("%") >= 0) return null;
        let v = parseFloat(str);
        return isNaN(v) ? null : v;
    }

    // Bounding box of produced layers (fallback document size when nothing is declared).
    function contentBounds(layers){
        let maxX = 0, maxY = 0;
        layers.forEach(l=>{
            if (l.kind === "image"){ maxX = Math.max(maxX, l.x + l.width); maxY = Math.max(maxY, l.y + l.height); }
            else if (l.kind === "vector"){
                for (let id in l.vector.nodes){ let nd = l.vector.nodes[id]; maxX = Math.max(maxX, nd.x); maxY = Math.max(maxY, nd.y); }
            }
        });
        return {width: maxX, height: maxY};
    }

    // A top-level <image> → pixel-layer spec (position from its x/y and any transform translate).
    function imageSpec(el, matrix){
        let href = el.getAttribute("href") || el.getAttributeNS(XLINKNS, "href") || el.getAttribute("xlink:href");
        if (!href) return null;
        let m = matMul(matrix, parseTransform(el.getAttribute("transform")));
        let x = num(el,"x"), y = num(el,"y"), w = num(el,"width"), h = num(el,"height");
        let o = apply(m, {x:x, y:y});
        return {kind:"image", name: el.getAttribute("id") || "Image", opacity: opacityOf(el), blend: blendOf(el),
                x: Math.round(o.x), y: Math.round(o.y), width: w, height: h, dataUrl: href};
    }

    return me;
}();

export default SVG;
