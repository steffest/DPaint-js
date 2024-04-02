import EventBus from "./eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Palette from "../ui/palette.js";
import ImageFile from "../image.js";
import Color from "./color.js";

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
			{ Name: "checks1", label: "Checks (very low)", pattern : [ 1 * 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] },
			{ Name: "checks2", label: "Checks (low)", pattern :  [ 2 * 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] },
			{ Name: "checks3", label: "Checks (medium)", pattern: [ 4 * 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] },
			{ Name: "checks4", label: "Checks (high)", pattern : [ 8 * 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] },
			{ Name: "checks5", label: "Checks (very high)", pattern: [ 16 * 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] },
			{ Name: "checks6", label: "Checks (very high 2)", pattern: [ 32 * 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] },
			{ Name: "fs", label: "Floyd-Steinberg", pattern: [ 0, 0, 0, 7.0 / 16.0, 0, 0, 3.0 / 16.0, 5.0 / 16.0, 1.0 / 16.0, 0, 0, 0, 0, 0, 0 ] },
			{ Name: "fs85", label: "Floyd-Steinberg (85%)", pattern: [ 0, 0, 0, 7.0 * 0.85 / 16.0, 0, 0, 3.0 * 0.85 / 16.0, 5.0 * 0.85 / 16.0, 1.0 * 0.85 / 16.0, 0, 0, 0, 0, 0, 0 ] },
			{ Name: "fs75", label: "Floyd-Steinberg (75%)", pattern: [ 0, 0, 0, 7.0 * 0.75 / 16.0, 0, 0, 3.0 * 0.75 / 16.0, 5.0 * 0.75 / 16.0, 1.0 * 0.75 / 16.0, 0, 0, 0, 0, 0, 0 ] },
			{ Name: "fs50", label: "Floyd-Steinberg (50%)", pattern: [ 0, 0, 0, 7.0 * 0.5 / 16.0, 0, 0, 3.0 * 0.5 / 16.0, 5.0 * 0.5 / 16.0, 1.0 * 0.5 / 16.0, 0, 0, 0, 0, 0, 0 ] },
			{ Name: "jjn", label: "Jarvis, Judice, and Ninke", pattern: [ 0, 0, 0, 7.0 / 48.0, 5.0 / 48.0, 3.0 / 48.0, 5.0 / 48.0, 7.0 / 48.0, 5.0 / 48.0, 3.0 / 48.0, 1.0 / 48.0, 3.0 / 48.0, 5.0 / 48.0, 3.0 / 48.0, 1.0 / 48.0 ] },
			{ Name: "s", label: "Stucki", pattern: [ 0, 0, 0, 8.0 / 42.0, 4.0 / 42.0, 2.0 / 42.0, 4.0 / 42.0, 8.0 / 42.0, 4.0 / 42.0, 2.0 / 42.0, 1.0 / 42.0, 2.0 / 42.0, 4.0 / 42.0, 2.0 / 42.0, 1.0 / 42.0 ] },
			{ Name: "a", label: "Atkinson", pattern: [ 0, 0, 0, 1.0 / 8.0, 1.0 / 8.0, 0, 1.0 / 8.0, 1.0 / 8.0, 1.0 / 8.0, 0, 0, 0, 1.0 / 8.0, 0, 0 ] },
			{ Name: "b", label: "Burkes", pattern: [ 0, 0, 0, 8.0 / 32.0, 4.0 / 32.0, 2.0 / 32.0, 4.0 / 32.0, 8.0 / 32.0, 4.0 / 32.0, 2.0 / 32.0, 0, 0, 0, 0, 0 ] },
			{ Name: "s", label: "Sierra", pattern: [ 0, 0, 0, 5.0 / 32.0, 3.0 / 32.0, 2.0 / 32.0, 4.0 / 32.0, 5.0 / 32.0, 4.0 / 32.0, 2.0 / 32.0, 0, 2.0 / 32.0, 3.0 / 32.0, 2.0 / 32.0, 0 ] },
			{ Name: "trs", label: "Two-Row Sierra", pattern: [ 0, 0, 0, 4.0 / 16.0, 3.0 / 16.0, 1.0 / 16.0, 2.0 / 16.0, 3.0 / 16.0, 2.0 / 16.0, 1.0 / 16.0, 0, 0, 0, 0, 0 ] },
			{ Name: "sl", label: "Sierra Lite", pattern: [ 0, 0, 0, 2.0 / 4.0, 0, 0, 1.0 / 4.0, 1.0 / 4.0, 0, 0, 0, 0, 0, 0, 0 ] } ,
			//{ Name: "bayer", label: "Bayer", pattern: [0,15/255, 135/255, 45/255, 165/255, 195/255, 75/255, 225/255, 105/255, 60/255, 180/255, 30/255, 150/255 , 240/255, 120/255, 210/255, 90/255] }
		];
	var ditherPattern = null;
	var alphaThreshold = 44;
	var mattingColor = "rgb(149,149,149)";
	mattingColor = "rgb(192,192,192)";
	
	me.getDithering = function(){
		return dithering;
	};


	me.matting = function(){
		if (imageInfos.canvas){
			var opaqueCanvas = document.createElement("canvas");
			opaqueCanvas.width = imageInfos.canvas.width;
			opaqueCanvas.height = imageInfos.canvas.height;
			var opaqueCtx = opaqueCanvas.getContext("2d");
			opaqueCtx.fillStyle = mattingColor;
			opaqueCtx.fillRect(0,0,opaqueCanvas.width,opaqueCanvas.height);
			opaqueCtx.drawImage(imageInfos.canvas,0,0);
			
			var ctx = imageInfos.canvas.getContext("2d");
			
			var data = ctx.getImageData(0, 0, imageInfos.canvas.width, imageInfos.canvas.height);
			var opaqueData = opaqueCtx.getImageData(0, 0, imageInfos.canvas.width, imageInfos.canvas.height);

			for(var y = 0; y < imageInfos.canvas.height; y++){
				for(var x = 0; x < imageInfos.canvas.width; x++){
					var index = (x + y * imageInfos.canvas.width) * 4;
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
		imageInfos.canvas = canvas;

		let ctx = canvas.getContext("2d");
		let data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		let colorCube = new Uint32Array(256 * 256 * 256);
		let colors = [];

		for(var Y = 0; Y < canvas.height; Y++) {
			for(var X = 0; X < canvas.width; X++) {
				var pixelIndex = (X + Y * canvas.width) * 4;

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
	
	me.reduce = function(canvas,colors,_alphaThreshold,ditherIndex,useAlphaThreshold){

		alphaThreshold = _alphaThreshold || 0;
		ditherPattern = dithering[ditherIndex || 0].pattern;
		var bitsPerColor = 8;
		
		var mode = "Palette";
		if (!isNaN(colors)){
			mode = colors;
		}else{
			imageInfos.palette = colors;
		}

		
		imageInfos.canvas = canvas;
		imageInfos.colorCount = colors;

		if (useAlphaThreshold) me.matting();
		
		processImage(mode, bitsPerColor, ditherPattern, "id");
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
	
	function remapImage(canvas, Colors, ditherPattern) {
		var Context = canvas.getContext("2d");
		var Data = Context.getImageData(0, 0, canvas.width, canvas.height);

		var MixedColors = [];

		for(var Index = 0; Index < Colors.length; Index++)
			MixedColors.push({ Red: Colors[Index].Red, Green: Colors[Index].Green, Blue: Colors[Index].Blue, TrueRed: SrgbToRgb(Colors[Index].Red), TrueGreen: SrgbToRgb(Colors[Index].Green), TrueBlue: SrgbToRgb(Colors[Index].Blue) });

		if(ditherPattern && ditherPattern[0] > 0 && Colors.length <= 64) {
			for(var Index1 = 0; Index1 < Colors.length; Index1++){
				for(var Index2 = Index1 + 1; Index2 < Colors.length; Index2++) {
					var Luminance1 = SrgbToRgb(Colors[Index1].Red) * 0.21 + SrgbToRgb(Colors[Index1].Green) * 0.72 + SrgbToRgb(Colors[Index1].Blue) * 0.07;
					var Luminance2 = SrgbToRgb(Colors[Index2].Red) * 0.21 + SrgbToRgb(Colors[Index2].Green) * 0.72 + SrgbToRgb(Colors[Index2].Blue) * 0.07;
					var LuminanceDeltaSquare = (Luminance1 - Luminance2) * (Luminance1 - Luminance2);

					if(LuminanceDeltaSquare < ditherPattern[0] * ditherPattern[0])
					{
						var Red = RgbToSrgb((SrgbToRgb(Colors[Index1].Red) + SrgbToRgb(Colors[Index2].Red)) / 2.0);
						var Green = RgbToSrgb((SrgbToRgb(Colors[Index1].Green) + SrgbToRgb(Colors[Index2].Green)) / 2.0);
						var Blue = RgbToSrgb((SrgbToRgb(Colors[Index1].Blue) + SrgbToRgb(Colors[Index2].Blue)) / 2.0);

						MixedColors.push({ Index1: Index1, Index2: Index2, Red: Red, Green: Green, Blue: Blue, TrueRed: SrgbToRgb(Red), TrueGreen: SrgbToRgb(Green), TrueBlue: SrgbToRgb(Blue) });
					}
				}
			}
		}

		Colors = MixedColors;

		for(var Y = 0; Y < canvas.height; Y++) {
			for(var X = 0; X < canvas.width; X++)
			{
				var pixelIndex = (X + Y * canvas.width) * 4;
				var SrgbIndex = X + Y * canvas.width;

				var Red = Data.data[pixelIndex];
				var Green = Data.data[pixelIndex + 1];
				var Blue = Data.data[pixelIndex + 2];
				var alpha = Data.data[pixelIndex + 3];

				var TrueRed = SrgbToRgb(Red);
				var TrueGreen = SrgbToRgb(Green);
				var TrueBlue = SrgbToRgb(Blue);

				var Luminance = TrueRed * 0.21 + TrueGreen * 0.72 + TrueBlue * 0.07;
				
				if(alpha >= alphaThreshold) {
					// Find the matching color index.

					var LastDistance = Number.MAX_VALUE;
					var RemappedColorIndex = 0;

					for(var ColorIndex = 0; ColorIndex < Colors.length; ColorIndex++){
						var RedDelta = Colors[ColorIndex].TrueRed - TrueRed;
						var GreenDelta = Colors[ColorIndex].TrueGreen - TrueGreen;
						var BlueDelta = Colors[ColorIndex].TrueBlue - TrueBlue;
						var LuminanceDelta = Colors[ColorIndex].TrueRed * 0.21 + Colors[ColorIndex].TrueGreen * 0.72 + Colors[ColorIndex].TrueBlue * 0.07 - Luminance;

						var Distance = 0;

						if(Colors[ColorIndex].Index1 !== undefined)
						{
							var RedDelta1 = Colors[Colors[ColorIndex].Index1].TrueRed - TrueRed;
							var GreenDelta1 = Colors[Colors[ColorIndex].Index1].TrueGreen - TrueGreen;
							var BlueDelta1 = Colors[Colors[ColorIndex].Index1].TrueBlue - TrueBlue;

							var LuminanceDelta1 = Colors[Colors[ColorIndex].Index1].TrueRed * 0.21 + Colors[Colors[ColorIndex].Index1].TrueGreen * 0.72 + Colors[Colors[ColorIndex].Index1].TrueBlue * 0.07 - Luminance;

							var RedDelta2 = Colors[Colors[ColorIndex].Index2].TrueRed - TrueRed;
							var GreenDelta2 = Colors[Colors[ColorIndex].Index2].TrueGreen - TrueGreen;
							var BlueDelta2 = Colors[Colors[ColorIndex].Index2].TrueBlue - TrueBlue;

							var LuminanceDelta2 = Colors[Colors[ColorIndex].Index2].TrueRed * 0.21 + Colors[Colors[ColorIndex].Index2].TrueGreen * 0.72 + Colors[Colors[ColorIndex].Index2].TrueBlue * 0.07 - Luminance;

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
 							if(Colors[RemappedColorIndex].Index1 !== undefined)
							{
								if((X ^ Y) & 1)
									RemappedColorIndex = Colors[RemappedColorIndex].Index1;
								else
									RemappedColorIndex = Colors[RemappedColorIndex].Index2;
							}

							Data.data[pixelIndex] = Colors[RemappedColorIndex].Red;
							Data.data[pixelIndex + 1] = Colors[RemappedColorIndex].Green;
							Data.data[pixelIndex + 2] = Colors[RemappedColorIndex].Blue;
							Data.data[pixelIndex + 3] = alpha;
						}
						else { // Error diffusion.
							var RedDelta = Colors[RemappedColorIndex].Red - Red;
							var GreenDelta = Colors[RemappedColorIndex].Green - Green;
							var BlueDelta = Colors[RemappedColorIndex].Blue - Blue;

							if(X < canvas.width - 2)
							{
								if(ditherPattern[4])
								{
									Data.data[pixelIndex + 8] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + 8] - RedDelta * ditherPattern[4])));
									Data.data[pixelIndex + 8 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + 8 + 1] - GreenDelta * ditherPattern[4])));
									Data.data[pixelIndex + 8 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + 8 + 2] - BlueDelta * ditherPattern[4])));
								}

								if(Y < canvas.height - 1 && ditherPattern[9])
								{
									Data.data[pixelIndex + canvas.width * 4 + 8] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 + 8] - RedDelta * ditherPattern[9])));
									Data.data[pixelIndex + canvas.width * 4 + 8 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 + 8 + 1] - GreenDelta * ditherPattern[9])));
									Data.data[pixelIndex + canvas.width * 4 + 8 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 + 8 + 2] - BlueDelta * ditherPattern[9])));
								}

								if(Y < canvas.height - 2 && ditherPattern[14])
								{
									Data.data[pixelIndex + canvas.width * 2 * 4 + 8] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 + 8] - RedDelta * ditherPattern[14])));
									Data.data[pixelIndex + canvas.width * 2 * 4 + 8 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 + 8 + 1] - GreenDelta * ditherPattern[14])));
									Data.data[pixelIndex + canvas.width * 2 * 4 + 8 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 + 8 + 2] - BlueDelta * ditherPattern[14])));
								}
							}

							if(X < canvas.width - 1)
							{
								if(ditherPattern[3])
								{
									Data.data[pixelIndex + 4] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + 4] - RedDelta * ditherPattern[3])));
									Data.data[pixelIndex + 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + 4 + 1] - GreenDelta * ditherPattern[3])));
									Data.data[pixelIndex + 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + 4 + 2] - BlueDelta * ditherPattern[3])));
								}

								if(Y < canvas.height - 1 && ditherPattern[8])
								{
									Data.data[pixelIndex + canvas.width * 4 + 4] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 + 4] - RedDelta * ditherPattern[8])));
									Data.data[pixelIndex + canvas.width * 4 + 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 + 4 + 1] - GreenDelta * ditherPattern[8])));
									Data.data[pixelIndex + canvas.width * 4 + 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 + 4 + 2] - BlueDelta * ditherPattern[8])));
								}

								if(Y < canvas.height - 2 && ditherPattern[13])
								{
									Data.data[pixelIndex + canvas.width * 2 * 4 + 4] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 + 4] - RedDelta * ditherPattern[13])));
									Data.data[pixelIndex + canvas.width * 2 * 4 + 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 + 4 + 1] - GreenDelta * ditherPattern[13])));
									Data.data[pixelIndex + canvas.width * 2 * 4 + 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 + 4 + 2] - BlueDelta * ditherPattern[13])));
								}
							}

							if(Y < canvas.height - 1 && ditherPattern[7])
							{
								Data.data[pixelIndex + canvas.width * 4] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4] - RedDelta * ditherPattern[7])));
								Data.data[pixelIndex + canvas.width * 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 + 1] - GreenDelta * ditherPattern[7])));
								Data.data[pixelIndex + canvas.width * 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 + 2] - BlueDelta * ditherPattern[7])));
							}

							if(Y < canvas.height - 2 && ditherPattern[12])
							{
								Data.data[pixelIndex + canvas.width * 2 * 4] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4] - RedDelta * ditherPattern[12])));
								Data.data[pixelIndex + canvas.width * 2 * 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 + 1] - GreenDelta * ditherPattern[12])));
								Data.data[pixelIndex + canvas.width * 2 * 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 + 2] - BlueDelta * ditherPattern[12])));
							}

							if(X > 0)
							{
								if(Y < canvas.height - 1 && ditherPattern[6])
								{
									Data.data[pixelIndex + canvas.width * 4 - 4] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 - 4] - RedDelta * ditherPattern[6])));
									Data.data[pixelIndex + canvas.width * 4 - 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 - 4 + 1] - GreenDelta * ditherPattern[6])));
									Data.data[pixelIndex + canvas.width * 4 - 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 - 4 + 2] - BlueDelta * ditherPattern[6])));
								}

								if(Y < canvas.height - 2 && ditherPattern[11])
								{
									Data.data[pixelIndex + canvas.width * 2 * 4 - 4] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 - 4] - RedDelta * ditherPattern[11])));
									Data.data[pixelIndex + canvas.width * 2 * 4 - 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 - 4 + 1] - GreenDelta * ditherPattern[11])));
									Data.data[pixelIndex + canvas.width * 2 * 4 - 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 - 4 + 2] - BlueDelta * ditherPattern[11])));
								}
							}

							if(X > 1)
							{
								if(Y < canvas.height - 1 && ditherPattern[5])
								{
									Data.data[pixelIndex + canvas.width * 4 - 8] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 - 8] - RedDelta * ditherPattern[5])));
									Data.data[pixelIndex + canvas.width * 4 - 8 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 - 8 + 1] - GreenDelta * ditherPattern[5])));
									Data.data[pixelIndex + canvas.width * 4 - 8 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 4 - 8 + 2] - BlueDelta * ditherPattern[5])));
								}

								if(Y < canvas.height - 2 && ditherPattern[10])
								{
									Data.data[pixelIndex + canvas.width * 2 * 4 - 8] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 - 8] - RedDelta * ditherPattern[10])));
									Data.data[pixelIndex + canvas.width * 2 * 4 - 8 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 - 8 + 1] - GreenDelta * ditherPattern[10])));
									Data.data[pixelIndex + canvas.width * 2 * 4 - 8 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[pixelIndex + canvas.width * 2 * 4 - 8 + 2] - BlueDelta * ditherPattern[10])));
								}
							}

							Data.data[pixelIndex] = Colors[RemappedColorIndex].Red;
							Data.data[pixelIndex + 1] = Colors[RemappedColorIndex].Green;
							Data.data[pixelIndex + 2] = Colors[RemappedColorIndex].Blue;
							Data.data[pixelIndex + 3] = alpha;
						}
					}
					else {
						var c = Colors[RemappedColorIndex];
						Data.data[pixelIndex] = c.Red;
						Data.data[pixelIndex + 1] = c.Green;
						Data.data[pixelIndex + 2] =c.Blue;
						Data.data[pixelIndex + 3] = alpha;
					}
				}
			}
		}

		Context.putImageData(Data, 0, 0);
	}

	function remapFullPaletteImage(Canvas, BitsPerColor, DitherPattern) {
		var Context = Canvas.getContext("2d");
		var Data = Context.getImageData(0, 0, Canvas.width, Canvas.height);
		var ShadesPerColor = 1 << BitsPerColor;

		for(var Y = 0; Y < Canvas.height; Y++) {
			for(var X = 0; X < Canvas.width; X++) {
				var PixelIndex = (X + Y * Canvas.width) * 4;

				var Red = Data.data[PixelIndex];
				var Green = Data.data[PixelIndex + 1];
				var Blue = Data.data[PixelIndex + 2];
				var Alpha = Data.data[PixelIndex + 3];
				var Luminance = Red * 0.21 + Green * 0.72 + Blue * 0.07;

				var MatchingRed = Red;
				var MatchingGreen = Green;
				var MatchingBlue = Blue;

				if(Alpha >= alphaThreshold) {
					if(DitherPattern) {
						if(DitherPattern[0] == 1) {
							// Checker pattern.
						}
						else {
							// Error diffusion.
							var ShadesScale = (ShadesPerColor - 1) / 255;
							var InverseShadesScale = 1 / ShadesScale;

							MatchingRed = Math.round(Math.round(Red * ShadesScale) * InverseShadesScale);
							MatchingGreen = Math.round(Math.round(Green * ShadesScale) * InverseShadesScale);
							MatchingBlue = Math.round(Math.round(Blue * ShadesScale) * InverseShadesScale);

							var RedDelta = MatchingRed - Red;
							var GreenDelta = MatchingGreen - Green;
							var BlueDelta = MatchingBlue - Blue;

							if(X < Canvas.width - 2) {
								if(DitherPattern[4])
								{
									Data.data[PixelIndex + 8] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + 8] - RedDelta * DitherPattern[4])));
									Data.data[PixelIndex + 8 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + 8 + 1] - GreenDelta * DitherPattern[4])));
									Data.data[PixelIndex + 8 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + 8 + 2] - BlueDelta * DitherPattern[4])));
								}

								if(Y < Canvas.height - 1 && DitherPattern[9])
								{
									Data.data[PixelIndex + Canvas.width * 4 + 8] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 + 8] - RedDelta * DitherPattern[9])));
									Data.data[PixelIndex + Canvas.width * 4 + 8 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 + 8 + 1] - GreenDelta * DitherPattern[9])));
									Data.data[PixelIndex + Canvas.width * 4 + 8 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 + 8 + 2] - BlueDelta * DitherPattern[9])));
								}

								if(Y < Canvas.height - 2 && DitherPattern[14])
								{
									Data.data[PixelIndex + Canvas.width * 2 * 4 + 8] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 + 8] - RedDelta * DitherPattern[14])));
									Data.data[PixelIndex + Canvas.width * 2 * 4 + 8 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 + 8 + 1] - GreenDelta * DitherPattern[14])));
									Data.data[PixelIndex + Canvas.width * 2 * 4 + 8 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 + 8 + 2] - BlueDelta * DitherPattern[14])));
								}
							}

							if(X < Canvas.width - 1)
							{
								if(DitherPattern[3])
								{
									Data.data[PixelIndex + 4] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + 4] - RedDelta * DitherPattern[3])));
									Data.data[PixelIndex + 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + 4 + 1] - GreenDelta * DitherPattern[3])));
									Data.data[PixelIndex + 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + 4 + 2] - BlueDelta * DitherPattern[3])));
								}

								if(Y < Canvas.height - 1 && DitherPattern[8])
								{
									Data.data[PixelIndex + Canvas.width * 4 + 4] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 + 4] - RedDelta * DitherPattern[8])));
									Data.data[PixelIndex + Canvas.width * 4 + 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 + 4 + 1] - GreenDelta * DitherPattern[8])));
									Data.data[PixelIndex + Canvas.width * 4 + 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 + 4 + 2] - BlueDelta * DitherPattern[8])));
								}

								if(Y < Canvas.height - 2 && DitherPattern[13])
								{
									Data.data[PixelIndex + Canvas.width * 2 * 4 + 4] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 + 4] - RedDelta * DitherPattern[13])));
									Data.data[PixelIndex + Canvas.width * 2 * 4 + 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 + 4 + 1] - GreenDelta * DitherPattern[13])));
									Data.data[PixelIndex + Canvas.width * 2 * 4 + 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 + 4 + 2] - BlueDelta * DitherPattern[13])));
								}
							}

							if(Y < Canvas.height - 1 && DitherPattern[7])
							{
								Data.data[PixelIndex + Canvas.width * 4] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4] - RedDelta * DitherPattern[7])));
								Data.data[PixelIndex + Canvas.width * 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 + 1] - GreenDelta * DitherPattern[7])));
								Data.data[PixelIndex + Canvas.width * 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 + 2] - BlueDelta * DitherPattern[7])));
							}

							if(Y < Canvas.height - 2 && DitherPattern[12])
							{
								Data.data[PixelIndex + Canvas.width * 2 * 4] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4] - RedDelta * DitherPattern[12])));
								Data.data[PixelIndex + Canvas.width * 2 * 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 + 1] - GreenDelta * DitherPattern[12])));
								Data.data[PixelIndex + Canvas.width * 2 * 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 + 2] - BlueDelta * DitherPattern[12])));
							}

							if(X > 0)
							{
								if(Y < Canvas.height - 1 && DitherPattern[6])
								{
									Data.data[PixelIndex + Canvas.width * 4 - 4] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 - 4] - RedDelta * DitherPattern[6])));
									Data.data[PixelIndex + Canvas.width * 4 - 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 - 4 + 1] - GreenDelta * DitherPattern[6])));
									Data.data[PixelIndex + Canvas.width * 4 - 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 - 4 + 2] - BlueDelta * DitherPattern[6])));
								}

								if(Y < Canvas.height - 2 && DitherPattern[11])
								{
									Data.data[PixelIndex + Canvas.width * 2 * 4 - 4] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 - 4] - RedDelta * DitherPattern[11])));
									Data.data[PixelIndex + Canvas.width * 2 * 4 - 4 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 - 4 + 1] - GreenDelta * DitherPattern[11])));
									Data.data[PixelIndex + Canvas.width * 2 * 4 - 4 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 - 4 + 2] - BlueDelta * DitherPattern[11])));
								}
							}

							if(X > 1)
							{
								if(Y < Canvas.height - 1 && DitherPattern[5])
								{
									Data.data[PixelIndex + Canvas.width * 4 - 8] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 - 8] - RedDelta * DitherPattern[5])));
									Data.data[PixelIndex + Canvas.width * 4 - 8 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 - 8 + 1] - GreenDelta * DitherPattern[5])));
									Data.data[PixelIndex + Canvas.width * 4 - 8 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 4 - 8 + 2] - BlueDelta * DitherPattern[5])));
								}

								if(Y < Canvas.height - 2 && DitherPattern[10])
								{
									Data.data[PixelIndex + Canvas.width * 2 * 4 - 8] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 - 8] - RedDelta * DitherPattern[10])));
									Data.data[PixelIndex + Canvas.width * 2 * 4 - 8 + 1] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 - 8 + 1] - GreenDelta * DitherPattern[10])));
									Data.data[PixelIndex + Canvas.width * 2 * 4 - 8 + 2] = Math.round(Math.min(255, Math.max(0, Data.data[PixelIndex + Canvas.width * 2 * 4 - 8 + 2] - BlueDelta * DitherPattern[10])));
								}
							}
						}
					}

					//console.error(MatchingRed);
					Data.data[PixelIndex] = MatchingRed;
					Data.data[PixelIndex + 1] = MatchingGreen;
					Data.data[PixelIndex + 2] = MatchingBlue;
					Data.data[PixelIndex + 3] = Alpha;
				}else{
					// transparency?
				}
			}
		}

		Context.putImageData(Data, 0, 0);
	}



	function processImage(colorCount, bitsPerColor, ditherPattern, Id) {
		var colors = [];
		var useTransparentColor = true;

		var transparentColor = useTransparentColor?Palette.getBackgroundColor():undefined;

		if(colorCount === "Palette") {
			for(var i = 0; i < imageInfos.palette.length; i++){
				var color = Color.fromString(imageInfos.palette[i]);
				colors.push({ Red: color[0], Green: color[1], Blue: color[2], Alpha: 255 });
			}
			imageInfos.QuantizedColors = colors;
			remapImage(imageInfos.canvas, colors, ditherPattern);
		}else{
			if(!imageInfos.Colors || imageInfos.Colors.length > colorCount) {
				if(colorCount === 2){
					if (useTransparentColor){
						colors.push({ Red: transparentColor[0], Green: transparentColor[1], Blue: transparentColor[2] });
					}else{
						colors.push({ Red: 255, Green: 255, Blue: 255 });
					}
					colors.push({ Red: 0, Green: 0, Blue: 0 });

					imageInfos.QuantizedColors = colors;

					remapImage(imageInfos.canvas, colors, ditherPattern);

					updateImageWindow(Id);
				}
				else
				{
					if (useTransparentColor) colorCount--;
					var MaxRecursionDepth = 1;

					while(Math.pow(2, MaxRecursionDepth) < colorCount) MaxRecursionDepth++;


					var QuantizeWorker = new Worker(
						new URL('../workers/quantize.js', import.meta.url),
						{type: 'module'}
					);

					var QuantizeData = { LineIndex: 0, CanvasData: imageInfos.canvas.getContext("2d").getImageData(0, 0, imageInfos.canvas.width, imageInfos.canvas.height), MaxRecursionDepth: MaxRecursionDepth, BitsPerColor: bitsPerColor, ColorCount: colorCount, transparentColor: transparentColor};

					QuantizeWorker.addEventListener(
						"message",
						function(e)
						{
							imageInfos.QuantizedColors = e.data.Colors;


							remapImage(imageInfos.canvas, imageInfos.QuantizedColors, ditherPattern);

							if (useTransparentColor && colorCount>4){
								imageInfos.QuantizedColors.unshift({Red: transparentColor[0], Green: transparentColor[1], Blue: transparentColor[2]})
							}

							updateImageWindow(Id);
						},
						false);

					QuantizeWorker.postMessage(QuantizeData);
					
				}

				return;
			}else{
				for (var Index = 0; Index < imageInfos.Colors.length; Index++)
					colors.push({ Red: imageInfos.Colors[Index].Red, Green: imageInfos.Colors[Index].Green, Blue: imageInfos.Colors[Index].Blue });
			}

			var ShadesPerColor = 1 << bitsPerColor;

			for(var Index = 0; Index < colors.length; Index++)
			{
				var ShadesScale = (ShadesPerColor - 1) / 255;
				var InverseShadesScale = 1 / ShadesScale;

				colors[Index].Red = Math.round(Math.round(colors[Index].Red * ShadesScale) * InverseShadesScale);
				colors[Index].Green = Math.round(Math.round(colors[Index].Green * ShadesScale) * InverseShadesScale);
				colors[Index].Blue = Math.round(Math.round(colors[Index].Blue * ShadesScale) * InverseShadesScale);
			}
		}

		// Remap image.

		if(colorCount === "Palette") {
			remapFullPaletteImage(imageInfos.canvas, bitsPerColor, ditherPattern);
		}

		imageInfos.QuantizedColors = colors;
		
		updateImageWindow(Id);
	}
	
	
	function updateImageWindow(){
		//console.error(imageInfos);
		
		if (imageInfos.QuantizedColors){
			var palette = [];
			imageInfos.QuantizedColors.forEach(function(c){
				palette.push([c.Red,c.Green,c.Blue]);
			});
			//console.error(palette);
			let f = ImageFile.getCurrentFile();
			let ctx = ImageFile.getActiveContext();
			ctx.clearRect(0,0,f.width,f.height);
			ctx.drawImage(imageInfos.canvas,0,0);
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