// Pixel-based fallback for CSS canvas filters (for browsers without ctx.filter support, e.g. Safari / IOS).
// Loaded dynamically only when needed.

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

export function applyPixelFilters(ctx, filters) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;

    for (const key in filters) {
        const value = filters[key];
        if (value === undefined) continue;
        switch (key) {
            case 'brightness': brightness(d, value); break;
            case 'contrast':   contrast(d, value);   break;
            case 'saturate':   saturate(d, value);   break;
            case 'hue-rotate': hueRotate(d, value);  break;
            case 'sepia':      sepia(d, value);      break;
            case 'invert':     invert(d, value);     break;
        }
    }

    ctx.putImageData(imgData, 0, 0);
}

function brightness(d, amount) {
    for (let i = 0; i < d.length; i += 4) {
        d[i]   = clamp(d[i]   * amount);
        d[i+1] = clamp(d[i+1] * amount);
        d[i+2] = clamp(d[i+2] * amount);
    }
}

function contrast(d, amount) {
    const intercept = 128 * (1 - amount);
    for (let i = 0; i < d.length; i += 4) {
        d[i]   = clamp(d[i]   * amount + intercept);
        d[i+1] = clamp(d[i+1] * amount + intercept);
        d[i+2] = clamp(d[i+2] * amount + intercept);
    }
}

function saturate(d, amount) {
    // SVG filter spec matrix
    const r1 = 0.213 + 0.787*amount, r2 = 0.715 - 0.715*amount, r3 = 0.072 - 0.072*amount;
    const g1 = 0.213 - 0.213*amount, g2 = 0.715 + 0.285*amount, g3 = 0.072 - 0.072*amount;
    const b1 = 0.213 - 0.213*amount, b2 = 0.715 - 0.715*amount, b3 = 0.072 + 0.928*amount;
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i+1], b = d[i+2];
        d[i]   = clamp(r*r1 + g*r2 + b*r3);
        d[i+1] = clamp(r*g1 + g*g2 + b*g3);
        d[i+2] = clamp(r*b1 + g*b2 + b*b3);
    }
}

function hueRotate(d, angleStr) {
    const rad = parseFloat(angleStr) * Math.PI / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const r1 = 0.213 + c*0.787 - s*0.213, r2 = 0.715 - c*0.715 - s*0.715, r3 = 0.072 - c*0.072 + s*0.928;
    const g1 = 0.213 - c*0.213 + s*0.143, g2 = 0.715 + c*0.285 + s*0.140, g3 = 0.072 - c*0.072 - s*0.283;
    const b1 = 0.213 - c*0.213 - s*0.787, b2 = 0.715 - c*0.715 + s*0.715, b3 = 0.072 + c*0.928 + s*0.072;
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i+1], b = d[i+2];
        d[i]   = clamp(r*r1 + g*r2 + b*r3);
        d[i+1] = clamp(r*g1 + g*g2 + b*g3);
        d[i+2] = clamp(r*b1 + g*b2 + b*b3);
    }
}

function sepia(d, amount) {
    const a = amount;
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i+1], b = d[i+2];
        d[i]   = clamp(r*(0.393*a + (1-a)) + g*0.769*a + b*0.189*a);
        d[i+1] = clamp(r*0.349*a + g*(0.686*a + (1-a)) + b*0.168*a);
        d[i+2] = clamp(r*0.272*a + g*0.534*a + b*(0.131*a + (1-a)));
    }
}

function invert(d, amount) {
    for (let i = 0; i < d.length; i += 4) {
        d[i]   = clamp(d[i]   + amount * (255 - 2*d[i]));
        d[i+1] = clamp(d[i+1] + amount * (255 - 2*d[i+1]));
        d[i+2] = clamp(d[i+2] + amount * (255 - 2*d[i+2]));
    }
}
