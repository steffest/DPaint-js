

// Optimized Box structure using TypedArrays
// Colors are stored in a flat Uint32Array: [r, g, b, count, r, g, b, count, ...]
// A Box is just a range [startIndex, endIndex] into this array.

function getBoxStats(colorsData, startIndex, endIndex) {
    let minR = 255, maxR = 0;
    let minG = 255, maxG = 0;
    let minB = 255, maxB = 0;
    let totalCount = 0;

    for (let i = startIndex; i < endIndex; i += 4) {
        let r = colorsData[i];
        let g = colorsData[i + 1];
        let b = colorsData[i + 2];
        let count = colorsData[i + 3];

        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (g < minG) minG = g;
        if (g > maxG) maxG = g;
        if (b < minB) minB = b;
        if (b > maxB) maxB = b;
        totalCount += count;
    }

    return {
        minR, maxR, minG, maxG, minB, maxB,
        totalCount,
        rRange: maxR - minR,
        gRange: maxG - minG,
        bRange: maxB - minB
    };
}

function getAverageColor(colorsData, startIndex, endIndex) {
    let r = 0, g = 0, b = 0;
    let total = 0;

    for (let i = startIndex; i < endIndex; i += 4) {
        let count = colorsData[i + 3];
        r += colorsData[i] * count;
        g += colorsData[i + 1] * count;
        b += colorsData[i + 2] * count;
        total += count;
    }

    if (total === 0) return [0, 0, 0];

    return [
        Math.round(r / total),
        Math.round(g / total),
        Math.round(b / total)
    ];
}

function medianCut(colorsData, targetCount) {
    // colorsData is a Uint32Array [r, g, b, count, ...]
    
    // Initial box covers all colors
    // Format: [startIndex, endIndex, score (count), minR, maxR, minG, maxG, minB, maxB]
    // Actually we just need start/end index and maybe cache the stats? 
    // Let's keep it simple: objects for boxes are fine as there are few boxes (max 256)
    
    let boxes = [{ start: 0, end: colorsData.length, stats: getBoxStats(colorsData, 0, colorsData.length) }];

    while (boxes.length < targetCount) {
        let bestScore = -1;
        let bestIndex = -1;

        for (let i = 0; i < boxes.length; i++) {
            if (boxes[i].end - boxes[i].start > 4) { // Can split? (more than 1 color)
                const score = boxes[i].stats.totalCount;
                if (score > bestScore) {
                    bestScore = score;
                    bestIndex = i;
                }
            }
        }

        if (bestIndex === -1) {
            break;
        }

        const box = boxes[bestIndex];
        const stats = box.stats;

        // Split logic
        const maxRange = Math.max(stats.rRange, stats.gRange, stats.bRange);
        let offset = 0; // 0=r, 1=g, 2=b
        if (maxRange === stats.gRange) offset = 1;
        if (maxRange === stats.bRange) offset = 2;

        // Sort the range in the TypedArray
        // We need to implement a partial sort or just sort the sub-array?
        // Sorting TypedArray in place is hard if we want to move 4-element tuples.
        // It's easier to copy to a temporary array of objects, sort, and copy back? 
        // OR better: use a custom sort function that swaps 4 elements at a time.
        
        // Quicksort implementation for 4-stride array
        quicksortColors(colorsData, box.start, box.end, offset);
        
        // Find median
        const halfCount = stats.totalCount / 2;
        let currentCount = 0;
        let splitIndex = box.start;

        for (let i = box.start; i < box.end; i += 4) {
            currentCount += colorsData[i+3];
            if (currentCount >= halfCount) {
                splitIndex = i + 4; // Include this color in first half
                break;
            }
        }
        
        // Safety clamps
        if (splitIndex >= box.end) splitIndex = box.end - 4;
        if (splitIndex <= box.start) splitIndex = box.start + 4;

        const box1 = { start: box.start, end: splitIndex, stats: getBoxStats(colorsData, box.start, splitIndex) };
        const box2 = { start: splitIndex, end: box.end, stats: getBoxStats(colorsData, splitIndex, box.end) };
        
        boxes[bestIndex] = box1;
        boxes.push(box2);
    }

    return boxes.map(b => getAverageColor(colorsData, b.start, b.end));
}

function quicksortColors(data, start, end, offset) {
    // Standard quicksort but operating on 4-element tuples in Uint32Array
    if (end - start <= 4) return;

    const pivotIndex = Math.floor((start + end) / 8) * 4; // Middle(-ish)
    const pivotValue = data[pivotIndex + offset];
    
    // Swap pivot to end
    swapColors(data, pivotIndex, end - 4);
    
    let storeIndex = start;
    for (let i = start; i < end - 4; i += 4) {
        if (data[i + offset] < pivotValue) {
            swapColors(data, i, storeIndex);
            storeIndex += 4;
        }
    }
    
    // Swap pivot to its final place
    swapColors(data, storeIndex, end - 4);
    
    quicksortColors(data, start, storeIndex, offset);
    quicksortColors(data, storeIndex + 4, end, offset);
}

function swapColors(data, i, j) {
    if (i === j) return;
    let t0 = data[i];
    let t1 = data[i+1];
    let t2 = data[i+2];
    let t3 = data[i+3];
    
    data[i] = data[j];
    data[i+1] = data[j+1];
    data[i+2] = data[j+2];
    data[i+3] = data[j+3];
    
    data[j] = t0;
    data[j+1] = t1;
    data[j+2] = t2;
    data[j+3] = t3;
}


self.onmessage = function (e) {
    try {
        const { imageData, count } = e.data;
        const pixels = imageData.data;

        // 1. Build Histogram
        const colorMap = new Map();
        const pixelCount = pixels.length / 4;
        // For larger images, sample a subset of pixels to speed up histogram generation
        // Aim for ~250k samples max for good performance/quality balance
        let step = 1;
        if (pixelCount > 250000) {
            step = Math.ceil(pixelCount / 250000);
        }
        // ensure alignment to 4 bytes
        const byteStep = step * 4;

        for (let i = 0; i < pixels.length; i += byteStep) {
            // Check alpha transparency
            if (pixels[i + 3] < 10) continue;

            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const key = (r << 16) | (g << 8) | b;
            colorMap.set(key, (colorMap.get(key) || 0) + 1);
        }

        // 2. Convert to Flat Array (Uint32Array)
        // [r, g, b, count, r, g, b, count...]
        const uniqueColorCount = colorMap.size;
        const colorsData = new Uint32Array(uniqueColorCount * 4);
        let idx = 0;
        
        for (let [key, count] of colorMap) {
            colorsData[idx++] = (key >> 16) & 0xFF; // r
            colorsData[idx++] = (key >> 8) & 0xFF;  // g
            colorsData[idx++] = key & 0xFF;         // b
            colorsData[idx++] = count;
        }
        
        if (uniqueColorCount === 0) {
             self.postMessage({ palette: [[0,0,0]] });
             self.close();
             return;
        }

        // 3. Quantize
        const palette = medianCut(colorsData, count);

        // 4. Return
        self.postMessage({ palette: palette });
    } catch (err) {
        console.error("Quantization Error:", err);
        self.postMessage({ palette: [[0,0,0]], error: err.message });
    } finally {
        self.close();
    }
};
