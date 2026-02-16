/*
 *  hamEncoder.js
 *
 *  Hold-And-Modify (HAM) encoder for Amiga ILBM files.
 *  Supports HAM6 (OCS/ECS, 6 bitplanes, 16-color base palette),
 *  HAM8 (AGA, 8 bitplanes, 64-color base palette), and
 *  SHAM (Sliced HAM — HAM6 with per-scanline palettes).
 *
 *  Each pixel is encoded as either a SET (palette lookup) or a MODIFY
 *  (replace one RGB channel from the previous pixel). Encoding uses a
 *  3-pixel lookahead per-scanline (HAM6/HAM8), or greedy (SHAM).
 */

const HAMEncoder = (function () {

    // ── Perceptual distance ──────────────────────────────────────────────

    // Weighted squared distance: 3R² + 4G² + 2B² (human luminance sensitivity).
    function weightedDist(dr, dg, db) {
        return 3 * dr * dr + 4 * dg * dg + 2 * db * db;
    }

    // ── Median-cut quantizer ─────────────────────────────────────────────
    // Ported from Quantize.swift. Operates on a 15-bit (5:5:5) histogram.

    function medianCutPalette(hist, targetCount) {
        var BIN_COUNT = 32768;

        function boxCount(box) {
            var c = 0;
            for (var r = box.r0; r <= box.r1; r++) {
                for (var g = box.g0; g <= box.g1; g++) {
                    var base = (r << 10) | (g << 5);
                    for (var b = box.b0; b <= box.b1; b++) {
                        c += hist[base | b];
                    }
                }
            }
            return c;
        }

        function shrink(box) {
            var r0 = 31, r1 = 0, g0 = 31, g1 = 0, b0 = 31, b1 = 0;
            var any = false;
            for (var r = box.r0; r <= box.r1; r++) {
                for (var g = box.g0; g <= box.g1; g++) {
                    var base = (r << 10) | (g << 5);
                    for (var b = box.b0; b <= box.b1; b++) {
                        if (hist[base | b] !== 0) {
                            any = true;
                            if (r < r0) r0 = r;
                            if (r > r1) r1 = r;
                            if (g < g0) g0 = g;
                            if (g > g1) g1 = g;
                            if (b < b0) b0 = b;
                            if (b > b1) b1 = b;
                        }
                    }
                }
            }
            if (any) {
                box.r0 = r0; box.r1 = r1;
                box.g0 = g0; box.g1 = g1;
                box.b0 = b0; box.b1 = b1;
            }
        }

        function splitBox(box) {
            var rRange = box.r1 - box.r0;
            var gRange = box.g1 - box.g0;
            var bRange = box.b1 - box.b0;

            // Split along widest axis.
            var axis;
            if (rRange >= gRange && rRange >= bRange) axis = 'r';
            else if (gRange >= rRange && gRange >= bRange) axis = 'g';
            else axis = 'b';

            // Project onto chosen axis.
            var totals = new Uint32Array(32);
            var low, high;
            if (axis === 'r') {
                low = box.r0; high = box.r1;
                for (var r = box.r0; r <= box.r1; r++) {
                    var c = 0;
                    for (var g = box.g0; g <= box.g1; g++) {
                        var base = (r << 10) | (g << 5);
                        for (var b = box.b0; b <= box.b1; b++) c += hist[base | b];
                    }
                    totals[r] = c;
                }
            } else if (axis === 'g') {
                low = box.g0; high = box.g1;
                for (var g = box.g0; g <= box.g1; g++) {
                    var c = 0;
                    for (var r = box.r0; r <= box.r1; r++) {
                        var base = (r << 10) | (g << 5);
                        for (var b = box.b0; b <= box.b1; b++) c += hist[base | b];
                    }
                    totals[g] = c;
                }
            } else {
                low = box.b0; high = box.b1;
                for (var b = box.b0; b <= box.b1; b++) {
                    var c = 0;
                    for (var r = box.r0; r <= box.r1; r++) {
                        for (var g = box.g0; g <= box.g1; g++) {
                            c += hist[(r << 10) | (g << 5) | b];
                        }
                    }
                    totals[b] = c;
                }
            }

            // Find count-balanced cut point.
            var total = box.count;
            if (total === 0) return null;

            var bestCut = -1, bestAcc = 0, bestDiff = 0xFFFFFFFF;
            var acc = 0;
            for (var coord = low; coord <= high; coord++) {
                acc += totals[coord];
                if (coord === high) break;
                var left = acc;
                var right = total - left;
                if (left === 0 || right === 0) continue;
                var diff = left > right ? left - right : right - left;
                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestCut = coord;
                    bestAcc = acc;
                    if (diff === 0) break;
                }
            }
            if (bestCut < 0) return null;

            // Create two child boxes.
            var a = {r0:box.r0,r1:box.r1,g0:box.g0,g1:box.g1,b0:box.b0,b1:box.b1,count:0};
            var bx = {r0:box.r0,r1:box.r1,g0:box.g0,g1:box.g1,b0:box.b0,b1:box.b1,count:0};
            if (axis === 'r') {
                a.r1 = bestCut; bx.r0 = bestCut + 1;
            } else if (axis === 'g') {
                a.g1 = bestCut; bx.g0 = bestCut + 1;
            } else {
                a.b1 = bestCut; bx.b0 = bestCut + 1;
            }
            a.count = bestAcc;
            bx.count = total - bestAcc;
            shrink(a);
            shrink(bx);
            return [a, bx];
        }

        function averageColor(box) {
            var rSum = 0, gSum = 0, bSum = 0, total = 0;
            for (var r = box.r0; r <= box.r1; r++) {
                for (var g = box.g0; g <= box.g1; g++) {
                    var base = (r << 10) | (g << 5);
                    for (var b = box.b0; b <= box.b1; b++) {
                        var c = hist[base | b];
                        if (c === 0) continue;
                        var rr = (r << 3) | 0x04;
                        var gg = (g << 3) | 0x04;
                        var bb = (b << 3) | 0x04;
                        rSum += rr * c;
                        gSum += gg * c;
                        bSum += bb * c;
                        total += c;
                    }
                }
            }
            if (total === 0) return {r: 0, g: 0, b: 0};
            return {
                r: Math.min(255, Math.round(rSum / total)),
                g: Math.min(255, Math.round(gSum / total)),
                b: Math.min(255, Math.round(bSum / total))
            };
        }

        function score(box) {
            var r = (box.r1 - box.r0) + 1;
            var g = (box.g1 - box.g0) + 1;
            var b = (box.b1 - box.b0) + 1;
            return box.count * r * g * b;
        }

        // Main loop.
        var root = {r0:0, r1:31, g0:0, g1:31, b0:0, b1:31, count:0};
        root.count = boxCount(root);
        shrink(root);

        var boxes = [root];
        while (boxes.length < targetCount) {
            // Sort by score descending.
            boxes.sort(function(a, b) {
                var sa = score(a), sb = score(b);
                if (sa !== sb) return sb - sa;
                if (a.count !== b.count) return b.count - a.count;
                var ra = a.r1 - a.r0, rb = b.r1 - b.r0;
                if (ra !== rb) return rb - ra;
                var ga = a.g1 - a.g0, gb = b.g1 - b.g0;
                if (ga !== gb) return gb - ga;
                return (b.b1 - b.b0) - (a.b1 - a.b0);
            });

            var didSplit = false;
            for (var i = 0; i < boxes.length; i++) {
                if (boxes[i].count === 0) continue;
                var result = splitBox(boxes[i]);
                if (!result) continue;
                boxes.splice(i, 1, result[0], result[1]);
                didSplit = true;
                break;
            }
            if (!didSplit) break;
        }

        // Extract palette colors and pad/trim to targetCount.
        var palette = boxes.map(averageColor);
        while (palette.length < targetCount) {
            palette.push(palette.length > 0 ? {r: palette[palette.length-1].r, g: palette[palette.length-1].g, b: palette[palette.length-1].b} : {r:0,g:0,b:0});
        }
        if (palette.length > targetCount) palette.length = targetCount;
        return palette;
    }

    // ── Edge-weighted histogram ──────────────────────────────────────────

    function buildEdgeWeightedHistogram(pixels, w, h) {
        var BIN_COUNT = 32768;
        var EDGE_THRESHOLD = 3000;
        var EDGE_WEIGHT = 3;
        var hist = new Uint32Array(BIN_COUNT);

        for (var y = 0; y < h; y++) {
            var rowStart = y * w * 4;

            // First pixel — no left neighbor, weight 1.
            var prevR = pixels[rowStart];
            var prevG = pixels[rowStart + 1];
            var prevB = pixels[rowStart + 2];
            var bin = ((prevR >> 3) << 10) | ((prevG >> 3) << 5) | (prevB >> 3);
            hist[bin]++;

            for (var x = 1; x < w; x++) {
                var off = rowStart + x * 4;
                var r = pixels[off];
                var g = pixels[off + 1];
                var b = pixels[off + 2];

                var dr = r - prevR;
                var dg = g - prevG;
                var db = b - prevB;
                var edgeMetric = dr * dr + dg * dg + db * db;
                var weight = edgeMetric > EDGE_THRESHOLD ? EDGE_WEIGHT : 1;

                bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
                hist[bin] += weight;

                prevR = r;
                prevG = g;
                prevB = b;
            }
        }
        return hist;
    }

    // ── 12-bit snapping (HAM6) ───────────────────────────────────────────

    function snap4(c8) {
        return ((c8 >> 4) * 17) | 0;
    }

    function snap12bit(palette) {
        return palette.map(function (c) {
            return {r: snap4(c.r), g: snap4(c.g), b: snap4(c.b)};
        });
    }

    // ── HAM6 palette deduplication ───────────────────────────────────────

    function key12(c) {
        return (Math.trunc(c.r / 17) << 8) | (Math.trunc(c.g / 17) << 4) | Math.trunc(c.b / 17);
    }

    function deduplicateHAM6Palette(palette, pixels, w, h) {
        var result = palette.map(function (c) { return {r: c.r, g: c.g, b: c.b}; });
        var seen = {};
        var dupeIndices = [];

        for (var i = 0; i < result.length; i++) {
            var k = key12(result[i]);
            if (seen[k]) {
                dupeIndices.push(i);
            } else {
                seen[k] = true;
            }
        }

        if (dupeIndices.length === 0) return result;

        // Build set of all 12-bit colors in the image.
        var imageColors = {};
        for (var y = 0; y < h; y++) {
            var rowStart = y * w * 4;
            for (var x = 0; x < w; x++) {
                var off = rowStart + x * 4;
                var r4 = pixels[off] >> 4;
                var g4 = pixels[off + 1] >> 4;
                var b4 = pixels[off + 2] >> 4;
                imageColors[(r4 << 8) | (g4 << 4) | b4] = true;
            }
        }

        // Remove colors already in palette.
        var paletteKeys = {};
        for (var i = 0; i < result.length; i++) paletteKeys[key12(result[i])] = true;

        var candidates = [];
        for (var ck in imageColors) {
            if (!paletteKeys[ck]) candidates.push(parseInt(ck));
        }

        // For each dupe slot, pick maximally distant candidate.
        for (var di = 0; di < dupeIndices.length; di++) {
            var dupeIdx = dupeIndices[di];
            if (candidates.length === 0) break;

            var bestCandIdx = 0;
            var bestMinDist = -1;
            for (var ci = 0; ci < candidates.length; ci++) {
                var ck = candidates[ci];
                var cr = (ck >> 8) & 0xF;
                var cg = (ck >> 4) & 0xF;
                var cb = ck & 0xF;
                var minDist = 0x7FFFFFFF;
                for (var pi = 0; pi < result.length; pi++) {
                    if (dupeIndices.indexOf(pi) >= 0 && pi >= dupeIdx) continue;
                    var pr = Math.trunc(result[pi].r / 17);
                    var pg = Math.trunc(result[pi].g / 17);
                    var pb = Math.trunc(result[pi].b / 17);
                    var dr = cr - pr, dg = cg - pg, db = cb - pb;
                    var d = weightedDist(dr, dg, db);
                    if (d < minDist) minDist = d;
                }
                if (minDist > bestMinDist) {
                    bestMinDist = minDist;
                    bestCandIdx = ci;
                }
            }

            var chosen = candidates.splice(bestCandIdx, 1)[0];
            var r4 = (chosen >> 8) & 0xF;
            var g4 = (chosen >> 4) & 0xF;
            var b4 = chosen & 0xF;
            result[dupeIdx] = {r: r4 * 17, g: g4 * 17, b: b4 * 17};
        }

        return result;
    }

    // ── Palette[0] optimization ──────────────────────────────────────────

    function optimizePalette0(palette, pixels, w, h, isHAM6) {
        if (h === 0 || palette.length === 0) return palette;

        // Collect left-column pixel colors.
        var leftPixels = [];
        for (var y = 0; y < h; y++) {
            var off = y * w * 4;
            var r = pixels[off];
            var g = pixels[off + 1];
            var b = pixels[off + 2];
            if (isHAM6) {
                r = (r >> 4) * 17;
                g = (g >> 4) * 17;
                b = (b >> 4) * 17;
            }
            leftPixels.push({r: r, g: g, b: b});
        }

        var bestIdx = 0;
        var bestError = 0x7FFFFFFFFFFFFFFF;
        for (var i = 0; i < palette.length; i++) {
            var pr = palette[i].r;
            var pg = palette[i].g;
            var pb = palette[i].b;
            var totalError = 0;
            for (var j = 0; j < leftPixels.length; j++) {
                var dr = leftPixels[j].r - pr;
                var dg = leftPixels[j].g - pg;
                var db = leftPixels[j].b - pb;
                totalError += weightedDist(dr, dg, db);
            }
            if (totalError < bestError) {
                bestError = totalError;
                bestIdx = i;
            }
        }

        if (bestIdx === 0) return palette;
        var result = palette.slice();
        var tmp = result[0];
        result[0] = result[bestIdx];
        result[bestIdx] = tmp;
        return result;
    }

    // ── SET lookup table ─────────────────────────────────────────────────

    function buildSetLUT(palette, isHAM6) {
        var BIN_COUNT = 32768;
        var palCount = palette.length;
        var palR = new Int32Array(palCount);
        var palG = new Int32Array(palCount);
        var palB = new Int32Array(palCount);
        for (var i = 0; i < palCount; i++) {
            palR[i] = palette[i].r;
            palG[i] = palette[i].g;
            palB[i] = palette[i].b;
        }

        var lut = new Uint8Array(BIN_COUNT);
        for (var r5 = 0; r5 < 32; r5++) {
            var rr = isHAM6 ? ((r5 >> 1) * 17) : ((r5 << 3) | 0x04);
            for (var g5 = 0; g5 < 32; g5++) {
                var gg = isHAM6 ? ((g5 >> 1) * 17) : ((g5 << 3) | 0x04);
                var binBase = (r5 << 10) | (g5 << 5);
                for (var b5 = 0; b5 < 32; b5++) {
                    var bb = isHAM6 ? ((b5 >> 1) * 17) : ((b5 << 3) | 0x04);
                    var best = 0;
                    var bestDist = 0x7FFFFFFF;
                    for (var pi = 0; pi < palCount; pi++) {
                        var dr = rr - palR[pi];
                        var dg = gg - palG[pi];
                        var db = bb - palB[pi];
                        var d = weightedDist(dr, dg, db);
                        if (d < bestDist) {
                            bestDist = d;
                            best = pi;
                            if (d === 0) break;
                        }
                    }
                    lut[binBase | b5] = best;
                }
            }
        }
        return lut;
    }

    // ── Scanline encoding (HAM6/HAM8) with 3-pixel lookahead ─────────────

    function bestFollowUpDist(nextR, nextG, nextB, prevR, prevG, prevB, setFollowDist, isHAM6) {
        var best = setFollowDist;

        // MODIFY Blue
        var actualB, db, dr, dg, d;
        if (isHAM6) {
            actualB = Math.trunc(nextB / 17) * 17;
            db = nextB - actualB;
            dr = nextR - prevR; dg = nextG - prevG;
            d = weightedDist(dr, dg, db);
            if (d < best) best = d;
        } else {
            actualB = ((nextB >> 2) << 2) | (prevB & 0x03);
            db = nextB - actualB;
            dr = nextR - prevR; dg = nextG - prevG;
            d = weightedDist(dr, dg, db);
            if (d < best) best = d;
        }

        // MODIFY Red
        var actualR;
        if (isHAM6) {
            actualR = Math.trunc(nextR / 17) * 17;
            dr = nextR - actualR;
            dg = nextG - prevG; db = nextB - prevB;
            d = weightedDist(dr, dg, db);
            if (d < best) best = d;
        } else {
            actualR = ((nextR >> 2) << 2) | (prevR & 0x03);
            dr = nextR - actualR;
            dg = nextG - prevG; db = nextB - prevB;
            d = weightedDist(dr, dg, db);
            if (d < best) best = d;
        }

        // MODIFY Green
        var actualG;
        if (isHAM6) {
            actualG = Math.trunc(nextG / 17) * 17;
            dg = nextG - actualG;
            dr = nextR - prevR; db = nextB - prevB;
            d = weightedDist(dr, dg, db);
            if (d < best) best = d;
        } else {
            actualG = ((nextG >> 2) << 2) | (prevG & 0x03);
            dg = nextG - actualG;
            dr = nextR - prevR; db = nextB - prevB;
            d = weightedDist(dr, dg, db);
            if (d < best) best = d;
        }

        return best;
    }

    function bestFollowUpDist2(nextR, nextG, nextB, nextSetR, nextSetG, nextSetB, nextSetDist,
                                next2R, next2G, next2B, next2SetDist,
                                prevR, prevG, prevB, isHAM6) {
        // Candidate 1: SET for next pixel.
        var best = nextSetDist + bestFollowUpDist(
            next2R, next2G, next2B, nextSetR, nextSetG, nextSetB, next2SetDist, isHAM6
        );

        // Candidate 2: MODIFY Blue for next pixel.
        var actualB, db, dr, dg, dist, total;
        if (isHAM6) {
            actualB = Math.trunc(nextB / 17) * 17;
            db = nextB - actualB; dr = nextR - prevR; dg = nextG - prevG;
            dist = weightedDist(dr, dg, db);
            total = dist + bestFollowUpDist(next2R, next2G, next2B, prevR, prevG, actualB, next2SetDist, isHAM6);
            if (total < best) best = total;
        } else {
            actualB = ((nextB >> 2) << 2) | (prevB & 0x03);
            db = nextB - actualB; dr = nextR - prevR; dg = nextG - prevG;
            dist = weightedDist(dr, dg, db);
            total = dist + bestFollowUpDist(next2R, next2G, next2B, prevR, prevG, actualB, next2SetDist, isHAM6);
            if (total < best) best = total;
        }

        // Candidate 3: MODIFY Red for next pixel.
        var actualR;
        if (isHAM6) {
            actualR = Math.trunc(nextR / 17) * 17;
            dr = nextR - actualR; dg = nextG - prevG; db = nextB - prevB;
            dist = weightedDist(dr, dg, db);
            total = dist + bestFollowUpDist(next2R, next2G, next2B, actualR, prevG, prevB, next2SetDist, isHAM6);
            if (total < best) best = total;
        } else {
            actualR = ((nextR >> 2) << 2) | (prevR & 0x03);
            dr = nextR - actualR; dg = nextG - prevG; db = nextB - prevB;
            dist = weightedDist(dr, dg, db);
            total = dist + bestFollowUpDist(next2R, next2G, next2B, actualR, prevG, prevB, next2SetDist, isHAM6);
            if (total < best) best = total;
        }

        // Candidate 4: MODIFY Green for next pixel.
        var actualG;
        if (isHAM6) {
            actualG = Math.trunc(nextG / 17) * 17;
            dg = nextG - actualG; dr = nextR - prevR; db = nextB - prevB;
            dist = weightedDist(dr, dg, db);
            total = dist + bestFollowUpDist(next2R, next2G, next2B, prevR, actualG, prevB, next2SetDist, isHAM6);
            if (total < best) best = total;
        } else {
            actualG = ((nextG >> 2) << 2) | (prevG & 0x03);
            dg = nextG - actualG; dr = nextR - prevR; db = nextB - prevB;
            dist = weightedDist(dr, dg, db);
            total = dist + bestFollowUpDist(next2R, next2G, next2B, prevR, actualG, prevB, next2SetDist, isHAM6);
            if (total < best) best = total;
        }

        return best;
    }

    // Tie-breaking: SET wins over MODIFY; among MODIFYs: Blue(1) < Red(2) < Green(3); smaller data wins.
    function shouldPreferModify(newType, newData, bestType, bestData) {
        if (bestType === 0) return false;
        if (newType !== bestType) return newType < bestType;
        return newData < bestData;
    }

    function encodeScanlines(pixels, w, h, palette, setLUT, isHAM6) {
        var controlShift = isHAM6 ? 4 : 6;
        var codes = new Uint8Array(w * h);

        var pR = new Int32Array(palette.length);
        var pG = new Int32Array(palette.length);
        var pB = new Int32Array(palette.length);
        for (var i = 0; i < palette.length; i++) {
            pR[i] = palette[i].r;
            pG[i] = palette[i].g;
            pB[i] = palette[i].b;
        }

        for (var y = 0; y < h; y++) {
            var prevR = pR[0], prevG = pG[0], prevB = pB[0];
            var rowStart = y * w * 4;
            var codeStart = y * w;

            for (var x = 0; x < w; x++) {
                var off = rowStart + x * 4;
                // RGBA layout
                var targetR = pixels[off];
                var targetG = pixels[off + 1];
                var targetB = pixels[off + 2];

                if (isHAM6) {
                    targetR = (targetR >> 4) * 17;
                    targetG = (targetG >> 4) * 17;
                    targetB = (targetB >> 4) * 17;
                }

                // ── Evaluate 4 candidates ──

                // 1. SET
                var bin = ((targetR >> 3) << 10) | ((targetG >> 3) << 5) | (targetB >> 3);
                var setIdx = setLUT[bin];
                var setR = pR[setIdx], setG = pG[setIdx], setB = pB[setIdx];
                var setDist = weightedDist(targetR - setR, targetG - setG, targetB - setB);

                var candDist0 = setDist, candCode0 = setIdx, candR0 = setR, candG0 = setG, candB0 = setB, candData0 = setIdx;

                // 2. MODIFY Blue (control 01)
                var data, actual, dr, dg, db;
                if (isHAM6) {
                    data = Math.trunc(targetB / 17);
                    actual = data * 17;
                } else {
                    data = targetB >> 2;
                    actual = (data << 2) | (prevB & 0x03);
                }
                db = targetB - actual; dr = targetR - prevR; dg = targetG - prevG;
                var candDist1 = weightedDist(dr, dg, db);
                var candCode1 = (1 << controlShift) | data;
                var candR1 = prevR, candG1 = prevG, candB1 = actual, candData1 = data;

                // 3. MODIFY Red (control 10)
                if (isHAM6) {
                    data = Math.trunc(targetR / 17);
                    actual = data * 17;
                } else {
                    data = targetR >> 2;
                    actual = (data << 2) | (prevR & 0x03);
                }
                dr = targetR - actual; dg = targetG - prevG; db = targetB - prevB;
                var candDist2 = weightedDist(dr, dg, db);
                var candCode2 = (2 << controlShift) | data;
                var candR2 = actual, candG2 = prevG, candB2 = prevB, candData2 = data;

                // 4. MODIFY Green (control 11)
                if (isHAM6) {
                    data = Math.trunc(targetG / 17);
                    actual = data * 17;
                } else {
                    data = targetG >> 2;
                    actual = (data << 2) | (prevG & 0x03);
                }
                dg = targetG - actual; dr = targetR - prevR; db = targetB - prevB;
                var candDist3 = weightedDist(dr, dg, db);
                var candCode3 = (3 << controlShift) | data;
                var candR3 = prevR, candG3 = actual, candB3 = prevB, candData3 = data;

                // ── Lookahead ──
                var total0 = candDist0;
                var total1 = candDist1;
                var total2 = candDist2;
                var total3 = candDist3;

                if (x + 2 < w) {
                    // Read next 2 pixels.
                    var nOff = rowStart + (x + 1) * 4;
                    var nextR = pixels[nOff], nextG = pixels[nOff + 1], nextB = pixels[nOff + 2];
                    var n2Off = rowStart + (x + 2) * 4;
                    var next2R = pixels[n2Off], next2G = pixels[n2Off + 1], next2B = pixels[n2Off + 2];

                    if (isHAM6) {
                        nextR = (nextR >> 4) * 17; nextG = (nextG >> 4) * 17; nextB = (nextB >> 4) * 17;
                        next2R = (next2R >> 4) * 17; next2G = (next2G >> 4) * 17; next2B = (next2B >> 4) * 17;
                    }

                    var nextBin = ((nextR >> 3) << 10) | ((nextG >> 3) << 5) | (nextB >> 3);
                    var nextSetIdx = setLUT[nextBin];
                    var nextSetR = pR[nextSetIdx], nextSetG = pG[nextSetIdx], nextSetB = pB[nextSetIdx];
                    var nextSetDist = weightedDist(nextR - nextSetR, nextG - nextSetG, nextB - nextSetB);

                    var next2Bin = ((next2R >> 3) << 10) | ((next2G >> 3) << 5) | (next2B >> 3);
                    var next2SetIdx = setLUT[next2Bin];
                    var next2SetR = pR[next2SetIdx], next2SetG = pG[next2SetIdx], next2SetB = pB[next2SetIdx];
                    var next2SetDist = weightedDist(next2R - next2SetR, next2G - next2SetG, next2B - next2SetB);

                    total0 += bestFollowUpDist2(nextR, nextG, nextB, nextSetR, nextSetG, nextSetB, nextSetDist,
                                                next2R, next2G, next2B, next2SetDist, candR0, candG0, candB0, isHAM6);
                    total1 += bestFollowUpDist2(nextR, nextG, nextB, nextSetR, nextSetG, nextSetB, nextSetDist,
                                                next2R, next2G, next2B, next2SetDist, candR1, candG1, candB1, isHAM6);
                    total2 += bestFollowUpDist2(nextR, nextG, nextB, nextSetR, nextSetG, nextSetB, nextSetDist,
                                                next2R, next2G, next2B, next2SetDist, candR2, candG2, candB2, isHAM6);
                    total3 += bestFollowUpDist2(nextR, nextG, nextB, nextSetR, nextSetG, nextSetB, nextSetDist,
                                                next2R, next2G, next2B, next2SetDist, candR3, candG3, candB3, isHAM6);
                } else if (x + 1 < w) {
                    // Second-to-last pixel: 2-pixel lookahead.
                    var nOff = rowStart + (x + 1) * 4;
                    var nextR = pixels[nOff], nextG = pixels[nOff + 1], nextB = pixels[nOff + 2];
                    if (isHAM6) {
                        nextR = (nextR >> 4) * 17; nextG = (nextG >> 4) * 17; nextB = (nextB >> 4) * 17;
                    }
                    var nextBin = ((nextR >> 3) << 10) | ((nextG >> 3) << 5) | (nextB >> 3);
                    var nextSetIdx = setLUT[nextBin];
                    var nsR = pR[nextSetIdx], nsG = pG[nextSetIdx], nsB = pB[nextSetIdx];
                    var setFollowDist = weightedDist(nextR - nsR, nextG - nsG, nextB - nsB);

                    total0 += bestFollowUpDist(nextR, nextG, nextB, candR0, candG0, candB0, setFollowDist, isHAM6);
                    total1 += bestFollowUpDist(nextR, nextG, nextB, candR1, candG1, candB1, setFollowDist, isHAM6);
                    total2 += bestFollowUpDist(nextR, nextG, nextB, candR2, candG2, candB2, setFollowDist, isHAM6);
                    total3 += bestFollowUpDist(nextR, nextG, nextB, candR3, candG3, candB3, setFollowDist, isHAM6);
                }

                // Pick best candidate.
                var bestIdx = 0, bestTotal = total0;

                if (total1 < bestTotal || (total1 === bestTotal && shouldPreferModify(1, candData1, bestIdx, candData0))) {
                    bestTotal = total1; bestIdx = 1;
                }
                var bestData2 = bestIdx === 0 ? candData0 : candData1;
                if (total2 < bestTotal || (total2 === bestTotal && shouldPreferModify(2, candData2, bestIdx, bestData2))) {
                    bestTotal = total2; bestIdx = 2;
                }
                var bestData3 = bestIdx === 0 ? candData0 : bestIdx === 1 ? candData1 : candData2;
                if (total3 < bestTotal || (total3 === bestTotal && shouldPreferModify(3, candData3, bestIdx, bestData3))) {
                    bestTotal = total3; bestIdx = 3;
                }

                // Emit best candidate.
                if (bestIdx === 0) {
                    codes[codeStart + x] = candCode0;
                    prevR = candR0; prevG = candG0; prevB = candB0;
                } else if (bestIdx === 1) {
                    codes[codeStart + x] = candCode1;
                    prevR = candR1; prevG = candG1; prevB = candB1;
                } else if (bestIdx === 2) {
                    codes[codeStart + x] = candCode2;
                    prevR = candR2; prevG = candG2; prevB = candB2;
                } else {
                    codes[codeStart + x] = candCode3;
                    prevR = candR3; prevG = candG3; prevB = candB3;
                }
            }
        }
        return codes;
    }

    // ── SHAM: per-scanline palette generation ────────────────────────────

    function buildScanlinePalettes(pixels, w, h) {
        var palettes = [];

        for (var y = 0; y < h; y++) {
            var rowStart = y * w * 4;

            // Build 12-bit histogram for this scanline.
            var hist12 = new Uint32Array(4096);
            for (var x = 0; x < w; x++) {
                var off = rowStart + x * 4;
                var r4 = pixels[off] >> 4;
                var g4 = pixels[off + 1] >> 4;
                var b4 = pixels[off + 2] >> 4;
                hist12[(r4 << 8) | (g4 << 4) | b4]++;
            }

            // Convert 12-bit histogram to 15-bit for median-cut.
            var hist15 = new Uint32Array(32768);
            for (var bin12 = 0; bin12 < 4096; bin12++) {
                if (hist12[bin12] === 0) continue;
                var r4 = (bin12 >> 8) & 0xF;
                var g4 = (bin12 >> 4) & 0xF;
                var b4 = bin12 & 0xF;
                var r5 = r4 * 2 + (r4 > 0 ? 1 : 0);
                var g5 = g4 * 2 + (g4 > 0 ? 1 : 0);
                var b5 = b4 * 2 + (b4 > 0 ? 1 : 0);
                hist15[(r5 << 10) | (g5 << 5) | b5] += hist12[bin12];
            }

            // Median-cut to 16 colors.
            var rawPalette = medianCutPalette(hist15, 16);

            // Snap to RGB444.
            rawPalette = snap12bit(rawPalette);

            // Deduplicate: replace dupes with black.
            var seen = {};
            for (var i = 0; i < rawPalette.length; i++) {
                var k = key12(rawPalette[i]);
                if (seen[k]) {
                    rawPalette[i] = {r: 0, g: 0, b: 0};
                }
                seen[k] = true;
            }

            // Optimize palette[0] for first pixel of this scanline.
            if (w > 0) {
                var firstR = (pixels[rowStart] >> 4) * 17;
                var firstG = (pixels[rowStart + 1] >> 4) * 17;
                var firstB = (pixels[rowStart + 2] >> 4) * 17;
                var bestIdx = 0, bestDist = 0x7FFFFFFF;
                for (var i = 0; i < rawPalette.length; i++) {
                    var dr = firstR - rawPalette[i].r;
                    var dg = firstG - rawPalette[i].g;
                    var db = firstB - rawPalette[i].b;
                    var d = weightedDist(dr, dg, db);
                    if (d < bestDist) { bestDist = d; bestIdx = i; }
                }
                if (bestIdx !== 0) {
                    var tmp = rawPalette[0];
                    rawPalette[0] = rawPalette[bestIdx];
                    rawPalette[bestIdx] = tmp;
                }
            }

            palettes.push(rawPalette);
        }

        return palettes;
    }

    // ── SHAM scanline encoder (greedy, no lookahead) ─────────────────────

    function encodeScanlinesSHAM(pixels, w, h, scanlinePalettes) {
        var controlShift = 4; // HAM6
        var codes = new Uint8Array(w * h);

        for (var y = 0; y < h; y++) {
            var pal = scanlinePalettes[y];
            var lut = buildSetLUT(pal, true); // isHAM6

            var palR = new Int32Array(pal.length);
            var palG = new Int32Array(pal.length);
            var palB = new Int32Array(pal.length);
            for (var i = 0; i < pal.length; i++) {
                palR[i] = pal[i].r;
                palG[i] = pal[i].g;
                palB[i] = pal[i].b;
            }

            var prevR = palR[0], prevG = palG[0], prevB = palB[0];
            var rowStart = y * w * 4;
            var codeStart = y * w;

            for (var x = 0; x < w; x++) {
                var off = rowStart + x * 4;
                var targetR = (pixels[off] >> 4) * 17;
                var targetG = (pixels[off + 1] >> 4) * 17;
                var targetB = (pixels[off + 2] >> 4) * 17;

                // SET candidate
                var bin = ((targetR >> 3) << 10) | ((targetG >> 3) << 5) | (targetB >> 3);
                var setIdx = lut[bin];
                var setR = palR[setIdx], setG = palG[setIdx], setB = palB[setIdx];
                var setDist = weightedDist(targetR - setR, targetG - setG, targetB - setB);

                var bestDist = setDist;
                var bestCode = setIdx;
                var bestR = setR, bestG = setG, bestB = setB;

                // MOD Blue
                var modBData = Math.trunc(targetB / 17);
                var modBActual = modBData * 17;
                var modBDist = weightedDist(targetR - prevR, targetG - prevG, targetB - modBActual);
                if (modBDist < bestDist) {
                    bestDist = modBDist;
                    bestCode = (1 << controlShift) | modBData;
                    bestR = prevR; bestG = prevG; bestB = modBActual;
                }

                // MOD Red
                var modRData = Math.trunc(targetR / 17);
                var modRActual = modRData * 17;
                var modRDist = weightedDist(targetR - modRActual, targetG - prevG, targetB - prevB);
                if (modRDist < bestDist) {
                    bestDist = modRDist;
                    bestCode = (2 << controlShift) | modRData;
                    bestR = modRActual; bestG = prevG; bestB = prevB;
                }

                // MOD Green
                var modGData = Math.trunc(targetG / 17);
                var modGActual = modGData * 17;
                var modGDist = weightedDist(targetR - prevR, targetG - modGActual, targetB - prevB);
                if (modGDist < bestDist) {
                    bestDist = modGDist;
                    bestCode = (3 << controlShift) | modGData;
                    bestR = prevR; bestG = modGActual; bestB = prevB;
                }

                codes[codeStart + x] = bestCode;
                prevR = bestR; prevG = bestG; prevB = bestB;
            }
        }
        return codes;
    }

    // ── Public API ───────────────────────────────────────────────────────

    /**
     * Encode an RGBA image as HAM6.
     * @param {Uint8Array|Uint8ClampedArray} rgbaPixels - RGBA pixel data from canvas.getImageData().
     * @param {number} w - Image width.
     * @param {number} h - Image height.
     * @returns {{ palette: Array<{r,g,b}>, codes: Uint8Array }}
     */
    function encodeHAM6(rgbaPixels, w, h) {
        if (w <= 0 || h <= 0) {
            return {palette: new Array(16).fill({r:0,g:0,b:0}), codes: new Uint8Array(0)};
        }

        // Step 1: Edge-weighted histogram → median-cut → 16-color palette.
        var hist = buildEdgeWeightedHistogram(rgbaPixels, w, h);
        var rawPalette = medianCutPalette(hist, 16);

        // Step 2: Snap to 12-bit, deduplicate.
        var palette = snap12bit(rawPalette);
        palette = deduplicateHAM6Palette(palette, rgbaPixels, w, h);

        // Step 3: Optimize palette[0] for left-column pixels.
        palette = optimizePalette0(palette, rgbaPixels, w, h, true);

        // Step 4: Build SET lookup table.
        var setLUT = buildSetLUT(palette, true);

        // Step 5: Encode scanlines with 3-pixel lookahead.
        var codes = encodeScanlines(rgbaPixels, w, h, palette, setLUT, true);

        return {palette: palette, codes: codes};
    }

    /**
     * Encode an RGBA image as HAM8.
     * @param {Uint8Array|Uint8ClampedArray} rgbaPixels - RGBA pixel data.
     * @param {number} w - Image width.
     * @param {number} h - Image height.
     * @returns {{ palette: Array<{r,g,b}>, codes: Uint8Array }}
     */
    function encodeHAM8(rgbaPixels, w, h) {
        if (w <= 0 || h <= 0) {
            return {palette: new Array(64).fill({r:0,g:0,b:0}), codes: new Uint8Array(0)};
        }

        // Step 1: Edge-weighted histogram → median-cut → 64-color palette.
        var hist = buildEdgeWeightedHistogram(rgbaPixels, w, h);
        var rawPalette = medianCutPalette(hist, 64);

        // Step 2: No snapping/dedup for HAM8.

        // Step 3: Optimize palette[0].
        var palette = optimizePalette0(rawPalette, rgbaPixels, w, h, false);

        // Step 4: Build SET LUT.
        var setLUT = buildSetLUT(palette, false);

        // Step 5: Encode scanlines with 3-pixel lookahead.
        var codes = encodeScanlines(rgbaPixels, w, h, palette, setLUT, false);

        return {palette: palette, codes: codes};
    }

    /**
     * Encode an RGBA image as SHAM (HAM6 with per-scanline palettes).
     * @param {Uint8Array|Uint8ClampedArray} rgbaPixels - RGBA pixel data.
     * @param {number} w - Image width.
     * @param {number} h - Image height.
     * @returns {{ palette: Array<{r,g,b}>, shamPalettes: Array<Array<{r,g,b}>>, codes: Uint8Array }}
     */
    function encodeSHAM(rgbaPixels, w, h) {
        if (w <= 0 || h <= 0) {
            return {palette: new Array(16).fill({r:0,g:0,b:0}), shamPalettes: [], codes: new Uint8Array(0)};
        }

        // Step 1: Generate per-scanline palettes.
        var scanlinePalettes = buildScanlinePalettes(rgbaPixels, w, h);

        // Step 2: Encode each scanline with its own palette (greedy, no lookahead).
        var codes = encodeScanlinesSHAM(rgbaPixels, w, h, scanlinePalettes);

        // Use scanline 0's palette as the global CMAP fallback.
        var globalPalette = scanlinePalettes.length > 0 ? scanlinePalettes[0] : new Array(16).fill({r:0,g:0,b:0});

        return {palette: globalPalette, shamPalettes: scanlinePalettes, codes: codes};
    }

    return {
        encodeHAM6: encodeHAM6,
        encodeHAM8: encodeHAM8,
        encodeSHAM: encodeSHAM
    };

})();

export default HAMEncoder;
