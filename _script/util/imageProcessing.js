import EventBus from "./eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Palette from "../ui/palette.js";
import ImageFile from "../image.js";
import Color from "./color.js";
import { runWebGLQuantizer } from "./webgl-quantizer.js";

var ImageProcessing = function(){
	var me = {};

	var imageInfos = {};

	// good explanation on dithering: https://tannerhelland.com/2012/12/28/dithering-eleven-algorithms-source-code.html
    // also: implement  https://twitter.com/lorenschmidt/status/1468671174821486594?s=20 ?

	// I kind of forgot where the original code came from.
	// maybe http://tool.anides.de/ ?
	// if so: credits to the original author. Sorry, I forgot your name.

	var dithering = [
			{ Name: "none", label: "None", pattern: null},
			{ Name: "checks", label: "Checks", pattern : [ 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] },
			{ Name: "fs", label: "Floyd-Steinberg", pattern: [ 0, 0, 0, 7.0 / 16.0, 0, 0, 3.0 / 16.0, 5.0 / 16.0, 1.0 / 16.0, 0, 0, 0, 0, 0, 0 ] },
			{ Name: "jjn", label: "Jarvis, Judice, and Ninke", pattern: [ 0, 0, 0, 7.0 / 48.0, 5.0 / 48.0, 3.0 / 48.0, 5.0 / 48.0, 7.0 / 48.0, 5.0 / 48.0, 3.0 / 48.0, 1.0 / 48.0, 3.0 / 48.0, 5.0 / 48.0, 3.0 / 48.0, 1.0 / 48.0 ] },
			{ Name: "s", label: "Stucki", pattern: [ 0, 0, 0, 8.0 / 42.0, 4.0 / 42.0, 2.0 / 42.0, 4.0 / 42.0, 8.0 / 42.0, 4.0 / 42.0, 2.0 / 42.0, 1.0 / 42.0, 2.0 / 42.0, 4.0 / 42.0, 2.0 / 42.0, 1.0 / 42.0 ] },
			{ Name: "a", label: "Atkinson", pattern: [ 0, 0, 0, 1.0 / 8.0, 1.0 / 8.0, 0, 1.0 / 8.0, 1.0 / 8.0, 1.0 / 8.0, 0, 0, 0, 1.0 / 8.0, 0, 0 ] },
			{ Name: "b", label: "Burkes", pattern: [ 0, 0, 0, 8.0 / 32.0, 4.0 / 32.0, 2.0 / 32.0, 4.0 / 32.0, 8.0 / 32.0, 4.0 / 32.0, 2.0 / 32.0, 0, 0, 0, 0, 0 ] },
			{ Name: "s", label: "Sierra", pattern: [ 0, 0, 0, 5.0 / 32.0, 3.0 / 32.0, 2.0 / 32.0, 4.0 / 32.0, 5.0 / 32.0, 4.0 / 32.0, 2.0 / 32.0, 0, 2.0 / 32.0, 3.0 / 32.0, 2.0 / 32.0, 0 ] },
			{ Name: "trs", label: "Two-Row Sierra", pattern: [ 0, 0, 0, 4.0 / 16.0, 3.0 / 16.0, 1.0 / 16.0, 2.0 / 16.0, 3.0 / 16.0, 2.0 / 16.0, 1.0 / 16.0, 0, 0, 0, 0, 0 ] },
			{ Name: "sl", label: "Sierra Lite", pattern: [ 0, 0, 0, 2.0 / 4.0, 0, 0, 1.0 / 4.0, 1.0 / 4.0, 0, 0, 0, 0, 0, 0, 0 ] } ,
			{ Name: "bayer", label: "Bayer", pattern: [0,15/255, 135/255, 45/255, 165/255, 195/255, 75/255, 225/255, 105/255, 60/255, 180/255, 30/255, 150/255 , 240/255, 120/255, 210/255, 90/255] }
		];
	var ditherPattern = null;
	var alphaThreshold = 44;
	var mattingColor = "rgb(149,149,149)";
	//mattingColor = "rgb(192,192,192)";
	//mattingColor = "rgb(39,44,46)";
	
	me.getDithering = function(){
		return dithering;
	};


	me.matting = function(canvas){
		if (canvas){
			var opaqueCanvas = document.createElement("canvas");
			opaqueCanvas.width = canvas.width;
			opaqueCanvas.height = canvas.height;
			var opaqueCtx = opaqueCanvas.getContext("2d");
			opaqueCtx.fillStyle = mattingColor;
			opaqueCtx.fillRect(0,0,opaqueCanvas.width,opaqueCanvas.height);
			opaqueCtx.drawImage(canvas,0,0);
			
			var ctx = canvas.getContext("2d");
			
			var data = ctx.getImageData(0, 0, canvas.width, canvas.height);
			var opaqueData = opaqueCtx.getImageData(0, 0, canvas.width, canvas.height);

			for(var y = 0; y < canvas.height; y++){
				for(var x = 0; x < canvas.width; x++){
					var index = (x + y * canvas.width) * 4;
					var alpha = data.data[index + 3];

					if(alpha < 255){
						if (alpha>=alphaThreshold){
							data.data[index] =  opaqueData.data[index];
							data.data[index + 1] = opaqueData.data[index + 1];
							data.data[index + 2] = opaqueData.data[index + 2];
							data.data[index + 3] = 255;
						}else{
							data.data[index + 3] = 0;
						}
					}
				}
			}
			ctx.putImageData(data, 0, 0);

			EventBus.trigger(EVENT.imageContentChanged)

		}
	};
	
	me.getColors = function(canvas,stopAtMax) {
        
        let ctx;
        if (canvas.getContext){
            ctx = canvas.getContext("2d");
            imageInfos.canvas = canvas;
        }else{
            if (canvas.canvas){
                ctx = canvas.canvas.getContext("2d");
                imageInfos.canvas = canvas.canvas;
            }else{
                // assuming context?
                 ctx = canvas;
                 // if canvas is a context, it might have a canvas property
                 imageInfos.canvas = canvas.canvas || canvas;
            }
        }
        
        let width = imageInfos.canvas.width;
        let height = imageInfos.canvas.height;

        if (!width || !height){
             // fallback for contexts that don't satisfy the above
             width = ctx.canvas ? ctx.canvas.width : (canvas.width || 0);
             height = ctx.canvas ? ctx.canvas.height : (canvas.height || 0);
        }

        if (typeof ctx.getImageData !== "function"){
             if (imageInfos.canvas && imageInfos.canvas.getContext){
                 ctx = imageInfos.canvas.getContext("2d");
             }else{
                 console.error("Context has no getImageData function", ctx);
                 return [];
             }
        }

		let data = ctx.getImageData(0, 0, width, height).data;
		let colorCube = new Uint32Array(256 * 256 * 256);
		let colors = [];
	
		for(var Y = 0; Y < height; Y++) {
			for(var X = 0; X < width; X++) {
				var pixelIndex = (X + Y * width) * 4;

				var red = data[pixelIndex];
				var green = data[pixelIndex + 1];
				var blue = data[pixelIndex + 2];
				var alpha = data[pixelIndex + 3];

				if(alpha >= alphaThreshold) {
					if(colorCube[red * 256 * 256 + green * 256 + blue] == 0)
						colors.push([red,green,blue]);

					colorCube[red * 256 * 256 + green * 256 + blue]++;
					if (stopAtMax && colors.length>stopAtMax) return colors;
				}
			}
		}

		colors.sort(function (c1, c2) { return (SrgbToRgb(c1[0]) * 0.21 + SrgbToRgb(c1[1]) * 0.72 + SrgbToRgb(c1[2]) * 0.07) - (SrgbToRgb(c2[0]) * 0.21 + SrgbToRgb(c2[1]) * 0.72 + SrgbToRgb(c2[2]) * 0.07) });
		return colors;

	};
	
	me.reduce = function(canvas,colors,_alphaThreshold,ditherIndex,useAlphaThreshold,ditherAmount,quantizationMethod){

		alphaThreshold = _alphaThreshold || 0;
		ditherPattern = dithering[ditherIndex || 0].pattern;
		if (ditherPattern){
			// clone ditherPattern
			ditherPattern = ditherPattern.slice();
			// apply ditherAmount
			if (typeof ditherAmount === "undefined") ditherAmount = 100;
			var amount = ditherAmount/100;

			// check for checker pattern
			if (ditherPattern[0] > 0 && ditherPattern[3] === 0){
				// checks
				var maxCheck = 16 * 8; // Max checks level
				ditherPattern[0] = Math.max(1, maxCheck * amount);
			}else if(ditherPattern.length>16){
				// bayer / ordered
				// store amount in index 0 for usage in shader/remap
				ditherPattern[0] = amount;
				for (var i=1;i<ditherPattern.length;i++){
					ditherPattern[i] = ditherPattern[i] * amount;
				}
			}else{
				// error diffusion
				for (var i=0;i<ditherPattern.length;i++){
					ditherPattern[i] = ditherPattern[i] * amount;
				}
			}
		}

		var bitsPerColor = 3;
		
		var mode = "Palette";
		if (!isNaN(colors)){
			mode = colors;
		}else{
			imageInfos.palette = colors;
		}

		
		imageInfos.canvas = canvas;
		imageInfos.colorCount = colors;

		if (useAlphaThreshold) me.matting(canvas);
		
		processImage(canvas, mode, bitsPerColor, ditherPattern, "id", quantizationMethod);
	};

	function RgbToSrgb(ColorChannel) {
		return Math.pow(ColorChannel / 255, 1 / 2.2) * 255;
	}

	function SrgbToRgb(ColorChannel) {
		return Math.pow(ColorChannel / 255, 2.2) * 255;
	}

	function colorDistance(RedDelta, GreenDelta, BlueDelta, LuminanceDelta) {
		return RedDelta * RedDelta + GreenDelta * GreenDelta + BlueDelta * BlueDelta + LuminanceDelta * LuminanceDelta * 6;
	}
	
	function remapImage(canvas, palette, ditherPattern) {
        
        let ditherType = null;
        let ditherAmount = 0;

        if (!ditherPattern) {
            ditherType = "none";
        } else if (ditherPattern.length > 16) {
            ditherType = "bayer";
            let amount = ditherPattern[0]; // This is 0..1
            ditherAmount = amount * palette.length; // Adaptation for shader logic
        }

        if (ditherType) {
             // ensure palette is compatible (array of arrays or objects -> array of arrays handled by webgl-quantizer now?)
             // actually webgl-quantizer handles objects now.
             // But we need to make sure we don't pass weird stuff.
             let success = runWebGLQuantizer(canvas, palette, ditherType, null, ditherAmount, 1.0);
             if (success) return;
        }

		let ctx = canvas.getContext("2d");
		let data = ctx.getImageData(0, 0, canvas.width, canvas.height);

		let mixedColors = [];


		for(let i = 0; i < palette.length; i++){
            let c = palette[i];
			let r = c[0];
			let g = c[1];
			let b = c[2];
			mixedColors.push({ r: r, g: g, b: b, TrueRed: SrgbToRgb(r), TrueGreen: SrgbToRgb(g), TrueBlue: SrgbToRgb(b) });
		}


		if(ditherPattern && ditherPattern[0] > 0 && palette.length <= 256) {
			console.log("Applying checks dithering. Pattern:", ditherPattern[0], "Palette size:", palette.length);
			let mixedCount = 0;
			for(var i2 = 0; i2 < palette.length; i2++){
				for(var i3 = i2 + 1; i3 < palette.length; i3++) {
					var luminance1 = mixedColors[i2].TrueRed * 0.21 + mixedColors[i2].TrueGreen * 0.72 + mixedColors[i2].TrueBlue * 0.07;
					var luminance2 = mixedColors[i3].TrueRed * 0.21 + mixedColors[i3].TrueGreen * 0.72 + mixedColors[i3].TrueBlue * 0.07;
					var luminanceDeltaSquare = (luminance1 - luminance2) * (luminance1 - luminance2);

					if(luminanceDeltaSquare < ditherPattern[0] * ditherPattern[0])
					{
						mixedCount++;
						let r = RgbToSrgb((mixedColors[i2].TrueRed + mixedColors[i3].TrueRed) / 2.0);
						let g = RgbToSrgb((mixedColors[i2].TrueGreen + mixedColors[i3].TrueGreen) / 2.0);
						let b = RgbToSrgb((mixedColors[i2].TrueBlue + mixedColors[i3].TrueBlue) / 2.0);

						mixedColors.push({ Index1: i2, Index2: i3, r: r, g: g, b: b, TrueRed: SrgbToRgb(r), TrueGreen: SrgbToRgb(g), TrueBlue: SrgbToRgb(b) });
					}
				}
			}
		}

		palette = mixedColors;

		for(var Y = 0; Y < canvas.height; Y++) {
			for(var X = 0; X < canvas.width; X++)
			{
				var pixelIndex = (X + Y * canvas.width) * 4;
				var SrgbIndex = X + Y * canvas.width;

				var Red = data.data[pixelIndex];
				var Green = data.data[pixelIndex + 1];
				var Blue = data.data[pixelIndex + 2];
				var alpha = data.data[pixelIndex + 3];

				var TrueRed = SrgbToRgb(Red);
				var TrueGreen = SrgbToRgb(Green);
				var TrueBlue = SrgbToRgb(Blue);

				if (ditherPattern && ditherPattern.length>16){
					// Bayer / Ordered Dither
					// Pattern values are 0..1
					// Center them around 0 (-0.5 .. 0.5)
					// And scale by amount (implied in the pattern values if we pre-scaled them, 
					// but wait, reduce() scales them 0..amount.
					
					// If pattern is [0, val, val...]
					// Index 0 is ignored for logic type usually, but for Bayer it is 0.
					
					// Let's use 4x4 tiling
					var bayerMap = (X%4) + (Y%4)*4;
					// The pattern array has 17 elements, index 0 is 0.
					// So indices 1..16 are the matrix.
					var bayerValue = ditherPattern[bayerMap+1]; 
					
					// bayerValue is 0..amount. 
					// We want to shift the color.
					// If amount is 1, bayerValue is 0..1. Center is 0.5.
					// shift = (bayerValue - amount/2) * 255 ?
					
					// Wait, standard ordered dither adds (MatrixValue - 0.5) * Range.
					
					// If we only have the scaled pattern, we don't know "amount" easily here, 
					// unless we infer it or assume the max value in array is 'amount'.
					
					// Let's reconstruct 'spread'.
					// But wait, reduce() scales the pattern.
					// ditherPattern[i] = orig[i] * amount.
					
					// So bayerValue is in range [0, amount].
					// We want to center it: bayerValue - (amount * 0.5).
					// Then scale to byte range: * 255?
					
					// Actually, let's look at the original values.
					// [15/255, 135/255...] -> roughly 0..1.
					// If amount=1, this is 0..1.
					// We want to add/subtract up to roughly 128 (half range) for full dither?
					// Or maybe the pattern values ARE the byte offsets effectively if normalized?
					
					// Let's try:
					// offset = (bayerValue - 0.5 * ditherAmount) * 255.
					// But we don't have ditherAmount variable here.
					
					// HACK: We can assume ditherPattern[0] holds 'amount' for Bayer if we set it so?
					// But currently ditherPattern[0] is 0.
					
					// Alternative: Just use the value as is and subtract a bias?
					// If we just add 0..amount, the image gets brighter.
					// We must subtract amount/2.
					
					// Let's estimate amount from the pattern? 
					// Or better: In reduce(), put 'amount' in ditherPattern[0] for Bayer?
					// Bayer doesn't use index 0 (it's 0 in definition). 
					// If I set ditherPattern[0] = amount, then:
					// 1. It won't trigger Checks (ditherPattern[0]>0 is true, but ditherPattern[3] is NOT 0 for Bayer, it's 45/255).
					// Checks check is: `if (ditherPattern[0] > 0 && ditherPattern[3] === 0)`
					// Bayer[3] is non-zero. So Checks won't trigger.
					// But Error Diffusion logic might trigger?
					// `else { // Error diffusion. }`
					// Correct.
					
					// So I need a distinct block for Bayer.
					// `if (ditherPattern.length > 16)` covers it.
					
					// So, let's set ditherPattern[0] = amount in reduce().
					// Then here:
					
					var amount = ditherPattern[0];
					var offset = (bayerValue - amount * 0.5) * 255;
					
					var R = Red + offset;
					var G = Green + offset;
					var B = Blue + offset;
					
					// Clamp?
					R = Math.max(0, Math.min(255, R));
					G = Math.max(0, Math.min(255, G));
					B = Math.max(0, Math.min(255, B));
					
					TrueRed = SrgbToRgb(R);
					TrueGreen = SrgbToRgb(G);
					TrueBlue = SrgbToRgb(B);
				}

				var Luminance = TrueRed * 0.21 + TrueGreen * 0.72 + TrueBlue * 0.07;
				
				if(alpha >= alphaThreshold) {
					// Find the matching color index.

					var LastDistance = Number.MAX_VALUE;
					var RemappedColorIndex = 0;

					for(var ColorIndex = 0; ColorIndex < palette.length; ColorIndex++){
						var RedDelta = palette[ColorIndex].TrueRed - TrueRed;
						var GreenDelta = palette[ColorIndex].TrueGreen - TrueGreen;
						var BlueDelta = palette[ColorIndex].TrueBlue - TrueBlue;
						var LuminanceDelta = palette[ColorIndex].TrueRed * 0.21 + palette[ColorIndex].TrueGreen * 0.72 + palette[ColorIndex].TrueBlue * 0.07 - Luminance;

						var Distance = 0;

						if(palette[ColorIndex].Index1 !== undefined)
						{
							var RedDelta1 = palette[palette[ColorIndex].Index1].TrueRed - TrueRed;
							var GreenDelta1 = palette[palette[ColorIndex].Index1].TrueGreen - TrueGreen;
							var BlueDelta1 = palette[palette[ColorIndex].Index1].TrueBlue - TrueBlue;

							var LuminanceDelta1 = palette[palette[ColorIndex].Index1].TrueRed * 0.21 + palette[palette[ColorIndex].Index1].TrueGreen * 0.72 + palette[palette[ColorIndex].Index1].TrueBlue * 0.07 - Luminance;

							var RedDelta2 = palette[palette[ColorIndex].Index2].TrueRed - TrueRed;
							var GreenDelta2 = palette[palette[ColorIndex].Index2].TrueGreen - TrueGreen;
							var BlueDelta2 = palette[palette[ColorIndex].Index2].TrueBlue - TrueBlue;

							var LuminanceDelta2 = palette[palette[ColorIndex].Index2].TrueRed * 0.21 + palette[palette[ColorIndex].Index2].TrueGreen * 0.72 + palette[palette[ColorIndex].Index2].TrueBlue * 0.07 - Luminance;

							Distance = colorDistance(RedDelta, GreenDelta, BlueDelta, LuminanceDelta) * 4;
							Distance += colorDistance(RedDelta1, GreenDelta1, BlueDelta1, LuminanceDelta1);
							Distance += colorDistance(RedDelta2, GreenDelta2, BlueDelta2, LuminanceDelta2);

							Distance /= 4 + 1 + 1;
						}
						else
						{
							Distance = colorDistance(RedDelta, GreenDelta, BlueDelta, LuminanceDelta);
						}


						if(Distance < LastDistance)
						{
							RemappedColorIndex = ColorIndex;
							LastDistance = Distance;
						}


					}

					if(ditherPattern) {
						if(ditherPattern[0] > 0) { // Checker pattern.
 							if(palette[RemappedColorIndex].Index1 !== undefined)
							{
								if((X ^ Y) & 1)
									RemappedColorIndex = palette[RemappedColorIndex].Index1;
								else
									RemappedColorIndex = palette[RemappedColorIndex].Index2;
							}

							data.data[pixelIndex] = palette[RemappedColorIndex].r;
							data.data[pixelIndex + 1] = palette[RemappedColorIndex].g;
							data.data[pixelIndex + 2] = palette[RemappedColorIndex].b;
							data.data[pixelIndex + 3] = alpha;
						}
						else if (ditherPattern.length > 16){
							// Bayer - already applied to color before matching
							// Just write the result
							var c = palette[RemappedColorIndex];
							data.data[pixelIndex] = c.r;
							data.data[pixelIndex + 1] = c.g;
							data.data[pixelIndex + 2] = c.b;
							data.data[pixelIndex + 3] = alpha;

						}
						else { // Error diffusion.
							var RedDelta = palette[RemappedColorIndex].r - Red;
							var GreenDelta = palette[RemappedColorIndex].g - Green;
							var BlueDelta = palette[RemappedColorIndex].b - Blue;

							if(X < canvas.width - 2)
							{
								if(ditherPattern[4])
								{
									data.data[pixelIndex + 8] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + 8] - RedDelta * ditherPattern[4])));
									data.data[pixelIndex + 8 + 1] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + 8 + 1] - GreenDelta * ditherPattern[4])));
									data.data[pixelIndex + 8 + 2] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + 8 + 2] - BlueDelta * ditherPattern[4])));
								}

								if(Y < canvas.height - 1 && ditherPattern[9])
								{
									data.data[pixelIndex + canvas.width * 4 + 8] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 + 8] - RedDelta * ditherPattern[9])));
									data.data[pixelIndex + canvas.width * 4 + 8 + 1] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 + 8 + 1] - GreenDelta * ditherPattern[9])));
									data.data[pixelIndex + canvas.width * 4 + 8 + 2] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 + 8 + 2] - BlueDelta * ditherPattern[9])));
								}

								if(Y < canvas.height - 2 && ditherPattern[14])
								{
									data.data[pixelIndex + canvas.width * 2 * 4 + 8] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 + 8] - RedDelta * ditherPattern[14])));
									data.data[pixelIndex + canvas.width * 2 * 4 + 8 + 1] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 + 8 + 1] - GreenDelta * ditherPattern[14])));
									data.data[pixelIndex + canvas.width * 2 * 4 + 8 + 2] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 + 8 + 2] - BlueDelta * ditherPattern[14])));
								}
							}

							if(X < canvas.width - 1)
							{
								if(ditherPattern[3])
								{
									data.data[pixelIndex + 4] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + 4] - RedDelta * ditherPattern[3])));
									data.data[pixelIndex + 4 + 1] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + 4 + 1] - GreenDelta * ditherPattern[3])));
									data.data[pixelIndex + 4 + 2] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + 4 + 2] - BlueDelta * ditherPattern[3])));
								}

								if(Y < canvas.height - 1 && ditherPattern[8])
								{
									data.data[pixelIndex + canvas.width * 4 + 4] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 + 4] - RedDelta * ditherPattern[8])));
									data.data[pixelIndex + canvas.width * 4 + 4 + 1] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 + 4 + 1] - GreenDelta * ditherPattern[8])));
									data.data[pixelIndex + canvas.width * 4 + 4 + 2] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 + 4 + 2] - BlueDelta * ditherPattern[8])));
								}

								if(Y < canvas.height - 2 && ditherPattern[13])
								{
									data.data[pixelIndex + canvas.width * 2 * 4 + 4] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 + 4] - RedDelta * ditherPattern[13])));
									data.data[pixelIndex + canvas.width * 2 * 4 + 4 + 1] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 + 4 + 1] - GreenDelta * ditherPattern[13])));
									data.data[pixelIndex + canvas.width * 2 * 4 + 4 + 2] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 + 4 + 2] - BlueDelta * ditherPattern[13])));
								}
							}

							if(Y < canvas.height - 1 && ditherPattern[7])
							{
								data.data[pixelIndex + canvas.width * 4] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4] - RedDelta * ditherPattern[7])));
								data.data[pixelIndex + canvas.width * 4 + 1] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 + 1] - GreenDelta * ditherPattern[7])));
								data.data[pixelIndex + canvas.width * 4 + 2] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 + 2] - BlueDelta * ditherPattern[7])));
							}

							if(Y < canvas.height - 2 && ditherPattern[12])
							{
								data.data[pixelIndex + canvas.width * 2 * 4] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4] - RedDelta * ditherPattern[12])));
								data.data[pixelIndex + canvas.width * 2 * 4 + 1] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 + 1] - GreenDelta * ditherPattern[12])));
								data.data[pixelIndex + canvas.width * 2 * 4 + 2] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 + 2] - BlueDelta * ditherPattern[12])));
							}

							if(X > 0)
							{
								if(Y < canvas.height - 1 && ditherPattern[6])
								{
									data.data[pixelIndex + canvas.width * 4 - 4] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 - 4] - RedDelta * ditherPattern[6])));
									data.data[pixelIndex + canvas.width * 4 - 4 + 1] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 - 4 + 1] - GreenDelta * ditherPattern[6])));
									data.data[pixelIndex + canvas.width * 4 - 4 + 2] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 - 4 + 2] - BlueDelta * ditherPattern[6])));
								}

								if(Y < canvas.height - 2 && ditherPattern[11])
								{
									data.data[pixelIndex + canvas.width * 2 * 4 - 4] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 - 4] - RedDelta * ditherPattern[11])));
									data.data[pixelIndex + canvas.width * 2 * 4 - 4 + 1] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 - 4 + 1] - GreenDelta * ditherPattern[11])));
									data.data[pixelIndex + canvas.width * 2 * 4 - 4 + 2] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 - 4 + 2] - BlueDelta * ditherPattern[11])));
								}
							}

							if(X > 1)
							{
								if(Y < canvas.height - 1 && ditherPattern[5])
								{
									data.data[pixelIndex + canvas.width * 4 - 8] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 - 8] - RedDelta * ditherPattern[5])));
									data.data[pixelIndex + canvas.width * 4 - 8 + 1] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 - 8 + 1] - GreenDelta * ditherPattern[5])));
									data.data[pixelIndex + canvas.width * 4 - 8 + 2] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 4 - 8 + 2] - BlueDelta * ditherPattern[5])));
								}

								if(Y < canvas.height - 2 && ditherPattern[10])
								{
									data.data[pixelIndex + canvas.width * 2 * 4 - 8] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 - 8] - RedDelta * ditherPattern[10])));
									data.data[pixelIndex + canvas.width * 2 * 4 - 8 + 1] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 - 8 + 1] - GreenDelta * ditherPattern[10])));
									data.data[pixelIndex + canvas.width * 2 * 4 - 8 + 2] = Math.round(Math.min(255, Math.max(0, data.data[pixelIndex + canvas.width * 2 * 4 - 8 + 2] - BlueDelta * ditherPattern[10])));
								}
							}

							data.data[pixelIndex] = palette[RemappedColorIndex].r;
							data.data[pixelIndex + 1] = palette[RemappedColorIndex].g;
							data.data[pixelIndex + 2] = palette[RemappedColorIndex].b;
							data.data[pixelIndex + 3] = alpha;
						}
					}
					else {
						var c = palette[RemappedColorIndex];
						data.data[pixelIndex] = c.r;
						data.data[pixelIndex + 1] = c.g;
						data.data[pixelIndex + 2] = c.b;
						data.data[pixelIndex + 3] = alpha;
					}
				}
			}
		}

		ctx.putImageData(data, 0, 0);
	}


	function processImage(canvas, colorCount, bitsPerColor, ditherPattern, Id, quantizationMethod) {
		var colors = [];
		var useTransparentColor = false;

		// scan image for transparent colors
		let imageData = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
		for(var i = 0; i < imageData.data.length; i+=4){
			if(imageData.data[i+3] < alphaThreshold){
				useTransparentColor = true;
				break;
			}
		}

		var transparentColor = useTransparentColor?Palette.getBackgroundColor():undefined;

		if(colorCount === "Palette") {
			for(var i = 0; i < imageInfos.palette.length; i++){
				var color = Color.fromString(imageInfos.palette[i]);
				colors.push([color[0],color[1],color[2]]);
			}
			imageInfos.paletteReduced = colors;
			remapImage(canvas, colors, ditherPattern);
		}else{

			// check if we can reuse the previous palette
			// we can reuse it if the color count is the same and we have a palette
			// AND if we are not reducing to specific bit depth (which is currently hardcoded to 3 anyway but let's be safe)
            // AND if the quantization method is the same?
            
			if (imageInfos.paletteReduced && imageInfos.paletteReduced.length === colorCount && !isNaN(colorCount)){
				// reuse palette
				// console.log("reusing palette for dithering");
				remapImage(canvas, imageInfos.paletteReduced, ditherPattern);
				updateImageWindow(Id, canvas, imageInfos.paletteReduced);
				return;
			}


			if(!imageInfos.Colors || imageInfos.Colors.length > colorCount) {
				if (useTransparentColor) colorCount--;
				var MaxRecursionDepth = 1;

				while(Math.pow(2, MaxRecursionDepth) < colorCount) MaxRecursionDepth++;


				let workerUrl = quantizationMethod === 1 ? '../workers/quantize2.js' : '../workers/quantize.js';
				let worker = new Worker(
					new URL(workerUrl, import.meta.url),
					{type: 'module'}
				);

				// when calculating the palette, we should NOT use dithering info
				// pure quantization based on the image colors
				let data = {
					imageData: canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height),
					colorDepth: bitsPerColor*3,
					count: colorCount,
					transparentColor
				};

				worker.addEventListener(
					"message",
					function(e)
					{
                        if (e.data.error) {
                            console.error("Worker Error:", e.data.error);
                            // Fallback? or just finish
                        }
						var paletteReduced = e.data.palette || [[0,0,0]];
						imageInfos.paletteReduced = paletteReduced; // cache the palette!

						// NOW apply dithering with the calculated palette
						remapImage(canvas, paletteReduced, ditherPattern);

						if (useTransparentColor && colorCount>4){
							// Use array format for consistency
							paletteReduced.unshift([
                                transparentColor[0],
                                transparentColor[1],
                                transparentColor[2]
                            ]);
						}

						updateImageWindow(Id, canvas, paletteReduced);
					},
					false);
                
                worker.addEventListener("error", function(e) {
                    console.error("Worker connection error:", e);
                    // Ensure we don't hang indenfinitely
                    EventBus.trigger(EVENT.paletteProcessingEnd);
                });

				worker.postMessage(data);
					
				

				return;
			}else{
				for (var Index = 0; Index < imageInfos.Colors.length; Index++) {
					colors.push(imageInfos.Colors[Index]);
                }
			}

			var ShadesPerColor = 1 << bitsPerColor;

			for(var Index = 0; Index < colors.length; Index++)
			{
				var ShadesScale = (ShadesPerColor - 1) / 255;
				var InverseShadesScale = 1 / ShadesScale;

				colors[Index][0] = Math.round(Math.round(colors[Index][0] * ShadesScale) * InverseShadesScale);
				colors[Index][1] = Math.round(Math.round(colors[Index][1] * ShadesScale) * InverseShadesScale);
				colors[Index][2] = Math.round(Math.round(colors[Index][2] * ShadesScale) * InverseShadesScale);
			}
		}

		imageInfos.paletteReduced = colors;
		updateImageWindow(Id, canvas, colors);
	}
	
	
	function updateImageWindow(Id, canvas, palette){
		if (palette){

			// check if we need to reduce the bit depth of the palette
			let colorDepth = Palette.getColorDepth();
			if (colorDepth !== 24){
				let bits = Math.floor(colorDepth/3);
				palette.forEach((color,index)=>{
					palette[index] = Color.setBitDepth(color,bits);
				});
			}

			// remove duplicates
			let uniquePalette = [];
			let map = {};
			palette.forEach(color=>{
				let key = color.join(",");
				if (!map[key]){
					map[key] = true;
					uniquePalette.push(color);
				}
			});
			palette = uniquePalette;

			// sort from dark to light
			palette.sort(function (c1, c2) { return (SrgbToRgb(c1[0]) * 0.21 + SrgbToRgb(c1[1]) * 0.72 + SrgbToRgb(c1[2]) * 0.07) - (SrgbToRgb(c2[0]) * 0.21 + SrgbToRgb(c2[1]) * 0.72 + SrgbToRgb(c2[2]) * 0.07) });

			let f = ImageFile.getCurrentFile();
			let ctx = ImageFile.getActiveContext();
			ctx.clearRect(0,0,f.width,f.height);
			ctx.drawImage(canvas,0,0);
			EventBus.trigger(EVENT.paletteProcessingEnd);
			EventBus.trigger(EVENT.layerContentChanged,{keepImageCache:true});
			Palette.set(palette);
			EventBus.trigger(COMMAND.INFO);
			//IconEditor.setPalette(palette);
			//IconEditor.updateIcon();
		}
	}

	me.rotate = function(canvas,left){
		let ctx = canvas.getContext("2d");
		let newCanvas = document.createElement("canvas");
		let w = canvas.height;
		let h = canvas.width;
		newCanvas.width = w;
		newCanvas.height = h;
		let newCtx = newCanvas.getContext("2d");
		newCtx.save();
		newCtx.translate(w/2,h/2);
		newCtx.rotate(90*Math.PI/180 * (left?-1:1));
		newCtx.drawImage(canvas, -h/2,-w/2);
		newCtx.restore();

		canvas.height = h;
		canvas.width = w;
		ctx.clearRect(0,0,w,h);
		ctx.drawImage(newCanvas,0,0);
		newCanvas = null;
	}

	me.bayer = function (ctx, threshold, whiteTransparent) {
		let image = ctx.getImageData(0,0,ctx.canvas.width, ctx.canvas.height);
		const thresholdMap = [
			[15, 135, 45, 165],
			[195, 75, 225, 105],
			[60, 180, 30, 150],
			[240, 120, 210, 90],
		];

		for (let i = 0; i < image.data.length; i += 4) {
			const luminance = (image.data[i] * 0.299) + (image.data[i + 1] * 0.587) + (image.data[i + 2] * 0.114);
			const x = i / 4 % image.width;
			const y = Math.floor(i / 4 / image.width);
			const map = Math.floor((luminance + thresholdMap[x % 4][y % 4]) / 2);
			//console.error(map);
			let value = map < threshold ? 0 : 255;
			image.data.fill(value, i, i + 3);
			if (whiteTransparent && value===255){
				image.data[i+3] = 0;
			}
		}

		ctx.putImageData(image,0,0);

	}


	// https://github.com/ytiurin/downscale/blob/master/src/downsample.js
	// MIT License - Copyright (c) 2017 Eugene Tiurin
	// seems "good enough" for our purpose and reasonable fast
	// TODO: implement in webworker
	// good article: https://stackoverflow.com/questions/18922880/html5-canvas-resize-downscale-image-high-quality
	// also checkout https://github.com/nodeca/pica
	// TODO; checkout createImageBitmap
	me.downScale = function(sourceImageData,destWidth, destHeight){
		function round(val)
		{
			return (val + 0.49) << 0
		}

		function downsample(sourceImageData, destWidth, destHeight, sourceX, sourceY,
							sourceWidth, sourceHeight)
		{
			var dest = new ImageData(destWidth, destHeight)

			var SOURCE_DATA  = new Int32Array(sourceImageData.data.buffer)
			var SOURCE_WIDTH = sourceImageData.width

			var DEST_DATA  = new Int32Array(dest.data.buffer)
			var DEST_WIDTH = dest.width

			var SCALE_FACTOR_X  = destWidth  / sourceWidth
			var SCALE_FACTOR_Y  = destHeight / sourceHeight
			var SCALE_RANGE_X   = round(1 / SCALE_FACTOR_X)
			var SCALE_RANGE_Y   = round(1 / SCALE_FACTOR_Y)
			var SCALE_RANGE_SQR = SCALE_RANGE_X * SCALE_RANGE_Y

			for (var destRow = 0; destRow < dest.height; destRow++) {
				for (var destCol = 0; destCol < DEST_WIDTH; destCol++) {

					var sourceInd = sourceX + round(destCol / SCALE_FACTOR_X) +
						(sourceY + round(destRow / SCALE_FACTOR_Y)) * SOURCE_WIDTH

					var destRed   = 0
					var destGreen = 0
					var destBlue  = 0
					var destAlpha = 0

					for (var sourceRow = 0; sourceRow < SCALE_RANGE_Y; sourceRow++)
						for (var sourceCol = 0; sourceCol < SCALE_RANGE_X; sourceCol++) {
							var sourcePx = SOURCE_DATA[sourceInd + sourceCol + sourceRow * SOURCE_WIDTH]
							destRed   += sourcePx <<  24 >>> 24
							destGreen += sourcePx <<  16 >>> 24
							destBlue  += sourcePx <<  8  >>> 24
							destAlpha += sourcePx >>> 24
						}

					destRed   = round(destRed   / SCALE_RANGE_SQR)
					destGreen = round(destGreen / SCALE_RANGE_SQR)
					destBlue  = round(destBlue  / SCALE_RANGE_SQR)
					destAlpha = round(destAlpha / SCALE_RANGE_SQR)

					DEST_DATA[destCol + destRow * DEST_WIDTH] =
						(destAlpha << 24) |
						(destBlue  << 16) |
						(destGreen << 8)  |
						(destRed)
				}
			}

			return dest
		}

		return downsample(sourceImageData, destWidth, destHeight, 0, 0, sourceImageData.width, sourceImageData.height);
	}



	// http://jsfiddle.net/HZewg/1/
	me.biCubic = function(sourceImageData,destWidth, destHeight){

		function TERP(t, a, b, c, d){
			return 0.5 * (c - a + (2.0*a - 5.0*b + 4.0*c - d + (3.0*(b - c) + d - a)*t)*t)*t + b;
		}

		function ivect(ix, iy, w) {
			// byte array, r,g,b,a
			return((ix + w * iy) * 4);
		}

		function BicubicInterpolation(x, y, values){
			var i0, i1, i2, i3;

			i0 = TERP(x, values[0][0], values[1][0], values[2][0], values[3][0]);
			i1 = TERP(x, values[0][1], values[1][1], values[2][1], values[3][1]);
			i2 = TERP(x, values[0][2], values[1][2], values[2][2], values[3][2]);
			i3 = TERP(x, values[0][3], values[1][3], values[2][3], values[3][3]);
			return TERP(y, i0, i1, i2, i3);
		}


		var dest = new ImageData(destWidth, destHeight);

		bicubic(sourceImageData, dest);
		return dest;
		function bicubic(srcImg, destImg) {

			let scaleX =  destWidth/sourceImageData.width;
			let scaleY =  destHeight/sourceImageData.height;

			var i, j;
			var dx, dy;
			var repeatX, repeatY;
			var offset_row0, offset_row1, offset_row2, offset_row3;
			var offset_col0, offset_col1, offset_col2, offset_col3;
			var red_pixels, green_pixels, blue_pixels, alpha_pixels;
			for (i = 0; i < destImg.height; ++i) {
				let iyv = i / scaleY;
				let iy0 = Math.floor(iyv);

				// We have to special-case the pixels along the border and repeat their values if necessary
				repeatY = 0;
				if(iy0 < 1) repeatY = -1;
				else if(iy0 > srcImg.height - 3) repeatY = iy0 - (srcImg.height - 3);

				for (j = 0; j < destImg.width; ++j) {
					let ixv = j / scaleX;
					let ix0 = Math.floor(ixv);

					// We have to special-case the pixels along the border and repeat their values if necessary
					repeatX = 0;
					if(ix0 < 1) repeatX = -1;
					else if(ix0 > srcImg.width - 3) repeatX = ix0 - (srcImg.width - 3);

					offset_row1 = ((iy0)   * srcImg.width + ix0) * 4;
					offset_row0 = repeatY < 0 ? offset_row1 : ((iy0-1) * srcImg.width + ix0) * 4;
					offset_row2 = repeatY > 1 ? offset_row1 : ((iy0+1) * srcImg.width + ix0) * 4;
					offset_row3 = repeatY > 0 ? offset_row2 : ((iy0+2) * srcImg.width + ix0) * 4;

					offset_col1 = 0;
					offset_col0 = repeatX < 0 ? offset_col1 : -4;
					offset_col2 = repeatX > 1 ? offset_col1 : 4;
					offset_col3 = repeatX > 0 ? offset_col2 : 8;

					//Each offset is for the start of a row's red pixels
					red_pixels = [[srcImg.data[offset_row0+offset_col0], srcImg.data[offset_row1+offset_col0], srcImg.data[offset_row2+offset_col0], srcImg.data[offset_row3+offset_col0]],
						[srcImg.data[offset_row0+offset_col1], srcImg.data[offset_row1+offset_col1], srcImg.data[offset_row2+offset_col1], srcImg.data[offset_row3+offset_col1]],
						[srcImg.data[offset_row0+offset_col2], srcImg.data[offset_row1+offset_col2], srcImg.data[offset_row2+offset_col2], srcImg.data[offset_row3+offset_col2]],
						[srcImg.data[offset_row0+offset_col3], srcImg.data[offset_row1+offset_col3], srcImg.data[offset_row2+offset_col3], srcImg.data[offset_row3+offset_col3]]];
					offset_row0++;
					offset_row1++;
					offset_row2++;
					offset_row3++;
					//Each offset is for the start of a row's green pixels
					green_pixels = [[srcImg.data[offset_row0+offset_col0], srcImg.data[offset_row1+offset_col0], srcImg.data[offset_row2+offset_col0], srcImg.data[offset_row3+offset_col0]],
						[srcImg.data[offset_row0+offset_col1], srcImg.data[offset_row1+offset_col1], srcImg.data[offset_row2+offset_col1], srcImg.data[offset_row3+offset_col1]],
						[srcImg.data[offset_row0+offset_col2], srcImg.data[offset_row1+offset_col2], srcImg.data[offset_row2+offset_col2], srcImg.data[offset_row3+offset_col2]],
						[srcImg.data[offset_row0+offset_col3], srcImg.data[offset_row1+offset_col3], srcImg.data[offset_row2+offset_col3], srcImg.data[offset_row3+offset_col3]]];
					offset_row0++;
					offset_row1++;
					offset_row2++;
					offset_row3++;
					//Each offset is for the start of a row's blue pixels
					blue_pixels = [[srcImg.data[offset_row0+offset_col0], srcImg.data[offset_row1+offset_col0], srcImg.data[offset_row2+offset_col0], srcImg.data[offset_row3+offset_col0]],
						[srcImg.data[offset_row0+offset_col1], srcImg.data[offset_row1+offset_col1], srcImg.data[offset_row2+offset_col1], srcImg.data[offset_row3+offset_col1]],
						[srcImg.data[offset_row0+offset_col2], srcImg.data[offset_row1+offset_col2], srcImg.data[offset_row2+offset_col2], srcImg.data[offset_row3+offset_col2]],
						[srcImg.data[offset_row0+offset_col3], srcImg.data[offset_row1+offset_col3], srcImg.data[offset_row2+offset_col3], srcImg.data[offset_row3+offset_col3]]];
					offset_row0++;
					offset_row1++;
					offset_row2++;
					offset_row3++;
					//Each offset is for the start of a row's alpha pixels
					alpha_pixels =[[srcImg.data[offset_row0+offset_col0], srcImg.data[offset_row1+offset_col0], srcImg.data[offset_row2+offset_col0], srcImg.data[offset_row3+offset_col0]],
						[srcImg.data[offset_row0+offset_col1], srcImg.data[offset_row1+offset_col1], srcImg.data[offset_row2+offset_col1], srcImg.data[offset_row3+offset_col1]],
						[srcImg.data[offset_row0+offset_col2], srcImg.data[offset_row1+offset_col2], srcImg.data[offset_row2+offset_col2], srcImg.data[offset_row3+offset_col2]],
						[srcImg.data[offset_row0+offset_col3], srcImg.data[offset_row1+offset_col3], srcImg.data[offset_row2+offset_col3], srcImg.data[offset_row3+offset_col3]]];

					// overall coordinates to unit square
					dx = ixv - ix0; dy = iyv - iy0;

					let idxD = ivect(j, i, destImg.width);

					destImg.data[idxD] = BicubicInterpolation(dx, dy, red_pixels);
					destImg.data[idxD+1] =  BicubicInterpolation(dx, dy, green_pixels);
					destImg.data[idxD+2] = BicubicInterpolation(dx, dy, blue_pixels);
					destImg.data[idxD+3] = BicubicInterpolation(dx, dy, alpha_pixels);
				}
			}
		}

	}

	return me;
}();

export default ImageProcessing;