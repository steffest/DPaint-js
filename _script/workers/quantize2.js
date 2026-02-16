function rgbToLab(r, g, b) {
	r /= 255;
	g /= 255;
	b /= 255;

	r = (r > 0.04045) ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
	g = (g > 0.04045) ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
	b = (b > 0.04045) ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

	let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
	let y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.00000;
	let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;

	x = (x > 0.008856) ? Math.pow(x, 1/3) : (7.787 * x) + 16/116;
	y = (y > 0.008856) ? Math.pow(y, 1/3) : (7.787 * y) + 16/116;
	z = (z > 0.008856) ? Math.pow(z, 1/3) : (7.787 * z) + 16/116;

	let L = (116 * y) - 16;
	let a = 500 * (x - y);
	let b_lab = 200 * (y - z);

	return [L, a, b_lab];
}

function getDeltaE76(lab1, lab2) {
	const dL = lab1[0] - lab2[0];
	const da = lab1[1] - lab2[1];
	const db = lab1[2] - lab2[2];
	return Math.sqrt(dL * dL + da * da + db * db);
}

function quantizeColor(r, g, b, bits) {
	let r_bits, g_bits, b_bits;

	if (bits === 24) {
		return [r, g, b];
	}


	if (bits === 12) {
		r_bits = 4; g_bits = 4; b_bits = 4;
	} else if (bits === 9) {
		r_bits = 3; g_bits = 3; b_bits = 3;
	} else {
		return [r, g, b];
	}

	const quantize = (val, bits) => {
		if (bits === 0) return 0;
		const levels = 1 << bits;
		if (levels === 1) return 128;
		const step = 255 / (levels - 1);
		return Math.round(Math.round(val / step) * step);
	}

	return [quantize(r, r_bits), quantize(g, g_bits), quantize(b, b_bits)];
}

function getAverageColor(pixels, colorDepth) {
	if (pixels.length === 0) return [0,0,0];
	let r = 0, g = 0, b = 0;
	for (const pixel of pixels) {
		r += pixel[0];
		g += pixel[1];
		b += pixel[2];
	}
	const len = pixels.length;
	let avg_r = Math.round(r / len);
	let avg_g = Math.round(g / len);
	let avg_b = Math.round(b / len);

	if (colorDepth) {
		[avg_r, avg_g, avg_b] = quantizeColor(avg_r, avg_g, avg_b, colorDepth);
	}

	return [avg_r, avg_g, avg_b];
}

function kMeansPalette(pixels, k, colorDepth) {
	let centroids = [];
	// Initialize centroids with random pixels
	const uniquePixels = Array.from(new Set(pixels.map(p => JSON.stringify(p)))).map(p => JSON.parse(p));
	for (let i = 0; i < k; i++) {
		centroids.push(uniquePixels[Math.floor(Math.random() * uniquePixels.length)]);
	}

	if (colorDepth) {
		centroids = centroids.map(c => quantizeColor(c[0], c[1], c[2], colorDepth));
	}

	const maxIterations = 10;
	for (let iter = 0; iter < maxIterations; iter++) {
		const clusters = Array.from({ length: k }, () => []);
		const pixelsLab = pixels.map(p => ({rgb: p, lab: rgbToLab(p[0], p[1], p[2])}));
		const centroidsLab = centroids.map(c => rgbToLab(c[0], c[1], c[2]));

		for (const pixel of pixelsLab) {
			let minDistance = Infinity;
			let clusterIndex = -1;
			for (let i = 0; i < k; i++) {
				const distance = getDeltaE76(pixel.lab, centroidsLab[i]);
				if (distance < minDistance) {
					minDistance = distance;
					clusterIndex = i;
				}
			}
			clusters[clusterIndex].push(pixel.rgb);
		}

		const newCentroids = [];
		for (let i = 0; i < k; i++) {
			if (clusters[i].length > 0) {
				newCentroids.push(getAverageColor(clusters[i], colorDepth));
			} else {
				// If a cluster is empty, re-initialize its centroid
				let randomPixel = uniquePixels[Math.floor(Math.random() * uniquePixels.length)];
				if (colorDepth) {
					randomPixel = quantizeColor(randomPixel[0], randomPixel[1], randomPixel[2], colorDepth);
				}
				newCentroids.push(randomPixel);
			}
		}

		// Check for convergence
		let converged = true;
		for (let i = 0; i < k; i++) {
			if (JSON.stringify(centroids[i]) !== JSON.stringify(newCentroids[i])) {
				converged = false;
				break;
			}
		}

		if (converged) {
			break;
		}

		centroids = newCentroids;
	}

	return centroids;
}

self.onmessage = function(e) {
	const { imageData, count, colorDepth } = e.data;
	const pixels = [];

	// don't count every pixel on large images - too slow
    const pixelCount = imageData.data.length / 4;
    let step = 1;
    if (pixelCount > 250000) step = Math.ceil(pixelCount / 250000);
    const byteStep = step * 4;

	for (let i = 0; i < imageData.data.length; i += byteStep) {
		pixels.push([imageData.data[i], imageData.data[i + 1], imageData.data[i + 2]]);
	}
	const palette = kMeansPalette(pixels, count, colorDepth);
	//const paletteLab = palette.map(color => ({ rgb: color, lab: rgbToLab(color[0], color[1], color[2]) }));
	self.postMessage({ palette });
};