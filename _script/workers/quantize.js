onmessage = function(e)
{
	let lineIndex = e.data.LineIndex;
	let canvasData = e.data.CanvasData;
	let maxRecursionDepth = e.data.MaxRecursionDepth;
	let bitsPerColor = e.data.BitsPerColor;
	let colorCount = e.data.ColorCount;
	let transparentColor = e.data.transparentColor;

	// for colorcount < 8 we use the transparent color as color - otherwise we just add it.
	let useTransParentColor = colorCount<7 && transparentColor;

	let colorCube = createColorCube(canvasData,useTransParentColor?transparentColor:undefined);

	let colorCubeInfo = TrimColorCube(colorCube, { RedMin: 0, RedMax: 255, GreenMin: 0, GreenMax: 255, BlueMin: 0, BlueMax: 255 });

	let colors = new Array();

	quantizeRecursive(colorCube, colorCubeInfo, colors, 0, maxRecursionDepth);

	if (transparentColor && !useTransParentColor){
		// this is probably not really correct but well ...
		colors.shift();
	}

	colors.sort(function (Color1, Color2) { return (Color1.Red * 0.21 + Color1.Green * 0.72 + Color1.Blue * 0.07) - (Color2.Red * 0.21 + Color2.Green * 0.72 + Color2.Blue * 0.07) });

	var ShadesPerColor = 1 << bitsPerColor;

	for(var Index = 0; Index < colors.length; Index++){
		colors[Index].Red = Math.floor(Math.floor(colors[Index].Red * ShadesPerColor / 256.0) * (255.0 / (ShadesPerColor - 1.0)));
		colors[Index].Green = Math.floor(Math.floor(colors[Index].Green * ShadesPerColor / 256.0) * (255.0 / (ShadesPerColor - 1.0)));
		colors[Index].Blue = Math.floor(Math.floor(colors[Index].Blue * ShadesPerColor / 256.0) * (255.0 / (ShadesPerColor - 1.0)));
	}

	for(var Index = colors.length; Index < colorCount; Index++) colors.push({ Red: 0, Green: 0, Blue: 0 });

	if (useTransParentColor){
		// force exact match and move in front
		var d=100000000;
		var i = -1;
		for(var Index = 0; Index < colors.length; Index++){
			var distance =
				Math.abs(colors[Index].Red - transparentColor[0]) +
				Math.abs(colors[Index].Green - transparentColor[1]) +
				Math.abs(colors[Index].Blue - transparentColor[2]);
			if (distance<d){
				d=distance;
				i=Index;
			}
		}
		if (i>=0){
			colors.splice(i,1);
			colors.unshift({Red: transparentColor[0], Green: transparentColor[1], Blue: transparentColor[2]})
		}
	}

	self.postMessage({ LineIndex: lineIndex, Colors: colors });

	self.close();
};

function createColorCube(CanvasData, transparentColor)
{
	var TotalColorCount = 0;
	var ColorCube = {}; // Note: an associative array is actually an object.

	for(var Y = 0; Y < CanvasData.height; Y++)
	{
		for(var X = 0; X < CanvasData.width; X++)
		{
			var PixelIndex = (X + Y * CanvasData.width) * 4;

			var Red = CanvasData.data[PixelIndex];
			var Green = CanvasData.data[PixelIndex + 1];
			var Blue = CanvasData.data[PixelIndex + 2];
			var Alpha = CanvasData.data[PixelIndex + 3];

			//console.error(Alpha);
			if (transparentColor && Alpha<100){
				Red = transparentColor[0];
				Green = transparentColor[1];
				Blue = transparentColor[2];
				Alpha = 255;
			};
			//var BitsPerColor = 4;
			//var ShadesPerColor = 1 << BitsPerColor;

			//Red = Math.round(Math.round(Red * (ShadesPerColor - 1) / 255) * 255 / (ShadesPerColor - 1));
			//Green = Math.round(Math.round(Green * (ShadesPerColor - 1) / 255) * 255 / (ShadesPerColor - 1));
			//Blue = Math.round(Math.round(Blue * (ShadesPerColor - 1) / 255) * 255 / (ShadesPerColor - 1));

			if(Alpha == 255)
			{
				if(ColorCube[Red * 256 * 256 + Green * 256 + Blue]){
					ColorCube[Red * 256 * 256 + Green * 256 + Blue]++;
				}else{
					ColorCube[Red * 256 * 256 + Green * 256 + Blue] = 1;
					TotalColorCount++;
				}
			}
		}
	}

	return ColorCube;
}

function TrimColorCube(ColorCube, ColorCubeInfo)
{
	var RedMin = 255;
	var RedMax = 0;

	var GreenMin = 255;
	var GreenMax = 0;

	var BlueMin = 255;
	var BlueMax = 0;

	var RedCounts = new Uint32Array(256);
	var GreenCounts = new Uint32Array(256);
	var BlueCounts = new Uint32Array(256);

	var TotalColorCount = 0;

	var AverageRed = 0;
	var AverageGreen = 0;
	var AverageBlue = 0;

	for(var Color in ColorCube)
	{
		var Red = Color >> 16;
		var Green = (Color >> 8) & 0xff;
		var Blue = Color & 0xff;

		if(Red >= ColorCubeInfo.RedMin && Red <= ColorCubeInfo.RedMax &&
			Green >= ColorCubeInfo.GreenMin && Green <= ColorCubeInfo.GreenMax &&
			Blue >= ColorCubeInfo.BlueMin && Blue <= ColorCubeInfo.BlueMax)
		{
			var ColorCount = ColorCube[Color];

			// throw JSON.stringify({ data: { Color: Color, Red: Red, Green: Green, Blue: Blue, ColorCount: ColorCount } });

			RedCounts[Red] += ColorCount;
			GreenCounts[Green] += ColorCount;
			BlueCounts[Blue] += ColorCount;

			if(Red < RedMin)
				RedMin = Red;

			if(Red > RedMax)
				RedMax = Red;

			if(Green < GreenMin)
				GreenMin = Green;

			if(Green > GreenMax)
				GreenMax = Green;

			if(Blue < BlueMin)
				BlueMin = Blue;

			if(Blue > BlueMax)
				BlueMax = Blue;

			AverageRed += Red * ColorCount;
			AverageGreen += Green * ColorCount;
			AverageBlue += Blue * ColorCount;

			TotalColorCount += ColorCount;
		}
	}

	AverageRed = Math.round(AverageRed / TotalColorCount);
	AverageGreen = Math.round(AverageGreen / TotalColorCount);
	AverageBlue = Math.round(AverageBlue / TotalColorCount);

	return { RedMin: RedMin, RedMax: RedMax, GreenMin: GreenMin, GreenMax: GreenMax, BlueMin: BlueMin, BlueMax: BlueMax, RedCounts: RedCounts, GreenCounts: GreenCounts, BlueCounts: BlueCounts, Red: AverageRed, Green: AverageGreen, Blue: AverageBlue, ColorCount: TotalColorCount };
}

function QuantizationCountWeight(Count)
{
	return Math.pow(Count, 0.2); // Standard.
	//return Math.pow(Count, 0.1);
	//return Count;
}

function quantizeRecursive(ColorCube, ColorCubeInfo, Palette, RecursionDepth, MaxRecursionDepth)
{
	var RedLength = ColorCubeInfo.RedMax - ColorCubeInfo.RedMin;
	var GreenLength = ColorCubeInfo.GreenMax - ColorCubeInfo.GreenMin;
	var BlueLength = ColorCubeInfo.BlueMax - ColorCubeInfo.BlueMin;

	if(Math.max(RedLength, GreenLength, BlueLength) == 1)
		return;

	if(RecursionDepth == MaxRecursionDepth)
	{
		Palette.push({ Red: ColorCubeInfo.Red, Green: ColorCubeInfo.Green, Blue: ColorCubeInfo.Blue });

		return;
	}

	var NewColorCubeInfo = new Array();

	NewColorCubeInfo.RedMin = ColorCubeInfo.RedMin;
	NewColorCubeInfo.RedMax = ColorCubeInfo.RedMax;
	NewColorCubeInfo.GreenMin = ColorCubeInfo.GreenMin;
	NewColorCubeInfo.GreenMax = ColorCubeInfo.GreenMax;
	NewColorCubeInfo.BlueMin = ColorCubeInfo.BlueMin;
	NewColorCubeInfo.BlueMax = ColorCubeInfo.BlueMax;

	if(RedLength >= GreenLength && RedLength >= BlueLength)
	{
		var LowIndex = ColorCubeInfo.RedMin;
		var HighIndex = ColorCubeInfo.RedMax;
		var LowCount = QuantizationCountWeight(ColorCubeInfo.RedCounts[LowIndex]);
		var HighCount = QuantizationCountWeight(ColorCubeInfo.RedCounts[HighIndex]);

		while(LowIndex < HighIndex - 1)
		{
			if(LowCount < HighCount)
			{
				LowCount += QuantizationCountWeight(ColorCubeInfo.RedCounts[++LowIndex]);
			}
			else
			{
				HighCount += QuantizationCountWeight(ColorCubeInfo.RedCounts[--HighIndex]);
			}
		}

		ColorCubeInfo.RedMax = LowIndex;
		NewColorCubeInfo.RedMin = HighIndex;
	}
	else if(GreenLength >= RedLength && GreenLength >= BlueLength)
	{
		var LowIndex = ColorCubeInfo.GreenMin;
		var HighIndex = ColorCubeInfo.GreenMax;
		var LowCount = QuantizationCountWeight(ColorCubeInfo.GreenCounts[LowIndex]);
		var HighCount = QuantizationCountWeight(ColorCubeInfo.GreenCounts[HighIndex]);

		while(LowIndex < HighIndex - 1)
		{
			if(LowCount < HighCount)
			{
				LowCount += QuantizationCountWeight(ColorCubeInfo.GreenCounts[++LowIndex]);
			}
			else
			{
				HighCount += QuantizationCountWeight(ColorCubeInfo.GreenCounts[--HighIndex]);
			}
		}

		ColorCubeInfo.GreenMax = LowIndex;
		NewColorCubeInfo.GreenMin = HighIndex;
	}
	else
	{
		var LowIndex = ColorCubeInfo.BlueMin;
		var HighIndex = ColorCubeInfo.BlueMax;
		var LowCount = QuantizationCountWeight(ColorCubeInfo.BlueCounts[LowIndex]);
		var HighCount = QuantizationCountWeight(ColorCubeInfo.BlueCounts[HighIndex]);

		while(LowIndex < HighIndex - 1)
		{
			if(LowCount < HighCount)
			{
				LowCount += QuantizationCountWeight(ColorCubeInfo.BlueCounts[++LowIndex]);
			}
			else
			{
				HighCount += QuantizationCountWeight(ColorCubeInfo.BlueCounts[--HighIndex]);
			}
		}

		ColorCubeInfo.BlueMax = LowIndex;
		NewColorCubeInfo.BlueMin = HighIndex;
	}

	quantizeRecursive(ColorCube, TrimColorCube(ColorCube, ColorCubeInfo), Palette, RecursionDepth + 1, MaxRecursionDepth);
	quantizeRecursive(ColorCube, TrimColorCube(ColorCube, NewColorCubeInfo), Palette, RecursionDepth + 1, MaxRecursionDepth);
}

function QuantizeColors(Canvas, ColorCount)
{
	var ColorCube = createColorCube(Canvas);
	var ColorCubeInfos = new Array(TrimColorCube(ColorCube, { RedMin: 0, RedMax: 255, GreenMin: 0, GreenMax: 255, BlueMin: 0, BlueMax: 255 }));

	while(ColorCubeInfos.length < ColorCount)
	{
		var LongestCubeLength = 0;
		var LongestCubeIndex = 0;

		var HeaviestCubeCount = 0;
		var HeaviestCubeIndex = 0;

		var RedLength;
		var GreenLength;
		var BlueLength;

		for(var Index = 0; Index < ColorCubeInfos.length; Index++)
		{
			RedLength = ColorCubeInfos[Index].RedMax - ColorCubeInfos[Index].RedMin;
			GreenLength = ColorCubeInfos[Index].GreenMax - ColorCubeInfos[Index].GreenMin;
			BlueLength = ColorCubeInfos[Index].BlueMax - ColorCubeInfos[Index].BlueMin;

			if(Math.max(RedLength, GreenLength, BlueLength) > LongestCubeLength)
			{
				LongestCubeLength = Math.max(RedLength, GreenLength, BlueLength);
				LongestCubeIndex = Index;
			}

			if(Math.max(RedLength, GreenLength, BlueLength) > 1 && ColorCubeInfos[Index].ColorCount > HeaviestCubeCount)
			{
				HeaviestCubeCount = ColorCubeInfos[Index].ColorCount;
				HeaviestCubeIndex = Index;
			}
		}

		var OldColorCubeInfo = ColorCubeInfos[LongestCubeIndex];
		//var OldColorCubeInfo = ColorCubeInfos[HeaviestCubeIndex];
		var NewColorCubeInfo = new Array();

		NewColorCubeInfo.RedMin = OldColorCubeInfo.RedMin;
		NewColorCubeInfo.RedMax = OldColorCubeInfo.RedMax;
		NewColorCubeInfo.GreenMin = OldColorCubeInfo.GreenMin;
		NewColorCubeInfo.GreenMax = OldColorCubeInfo.GreenMax;
		NewColorCubeInfo.BlueMin = OldColorCubeInfo.BlueMin;
		NewColorCubeInfo.BlueMax = OldColorCubeInfo.BlueMax;

		RedLength = OldColorCubeInfo.RedMax - OldColorCubeInfo.RedMin;
		GreenLength = OldColorCubeInfo.GreenMax - OldColorCubeInfo.GreenMin;
		BlueLength = OldColorCubeInfo.BlueMax - OldColorCubeInfo.BlueMin;

		if(RedLength >= GreenLength && RedLength >= BlueLength)
		{
			if(RedLength > 1)
			{
				var LowIndex = OldColorCubeInfo.RedMin;
				var HighIndex = OldColorCubeInfo.RedMax;
				var LowCount = Math.pow(OldColorCubeInfo.RedCounts[LowIndex], 0.2);
				var HighCount = Math.pow(OldColorCubeInfo.RedCounts[HighIndex], 0.2);

				while(LowIndex < HighIndex - 1)
				{
					if(LowCount < HighCount)
					{
						LowCount += Math.pow(OldColorCubeInfo.RedCounts[++LowIndex], 0.2);
					}
					else
					{
						HighCount += Math.pow(OldColorCubeInfo.RedCounts[--HighIndex], 0.2);
					}
				}

				//OldColorCubeInfo.RedMax = LowIndex;
				//NewColorCubeInfo.RedMin = HighIndex;

				NewColorCubeInfo.RedMax = OldColorCubeInfo.RedMax;
				OldColorCubeInfo.RedMax = OldColorCubeInfo.RedMin + Math.floor(RedLength / 2.0);
				NewColorCubeInfo.RedMin = OldColorCubeInfo.RedMax + 1;
			}
			else
			{
				break;
			}
		}
		else if(GreenLength >= RedLength && GreenLength >= BlueLength)
		{
			if(GreenLength > 1)
			{
				var LowIndex = OldColorCubeInfo.GreenMin;
				var HighIndex = OldColorCubeInfo.GreenMax;
				var LowCount = Math.pow(OldColorCubeInfo.GreenCounts[LowIndex], 0.2);
				var HighCount = Math.pow(OldColorCubeInfo.GreenCounts[HighIndex], 0.2);

				while(LowIndex < HighIndex - 1)
				{
					if(LowCount < HighCount)
					{
						LowCount += OldColorCubeInfo.GreenCounts[++LowIndex];
					}
					else
					{
						HighCount += OldColorCubeInfo.GreenCounts[--HighIndex];
					}
				}

				//OldColorCubeInfo.GreenMax = LowIndex;
				//NewColorCubeInfo.GreenMin = HighIndex;

				NewColorCubeInfo.GreenMax = OldColorCubeInfo.GreenMax;
				OldColorCubeInfo.GreenMax = OldColorCubeInfo.GreenMin + Math.floor(GreenLength / 2.0);
				NewColorCubeInfo.GreenMin = OldColorCubeInfo.GreenMax + 1;
			}
			else
			{
				break;
			}
		}
		else
		{
			if(BlueLength > 1)
			{
				var LowIndex = OldColorCubeInfo.BlueMin;
				var HighIndex = OldColorCubeInfo.BlueMax;
				var LowCount = Math.pow(OldColorCubeInfo.BlueCounts[LowIndex], 0.2);
				var HighCount = Math.pow(OldColorCubeInfo.BlueCounts[HighIndex], 0.2);

				while(LowIndex < HighIndex - 1)
				{
					if(LowCount < HighCount)
					{
						LowCount += Math.pow(OldColorCubeInfo.BlueCounts[++LowIndex], 0.2);
					}
					else
					{
						HighCount += Math.pow(OldColorCubeInfo.BlueCounts[--HighIndex], 0.2);
					}
				}

				//OldColorCubeInfo.BlueMax = LowIndex;
				//NewColorCubeInfo.BlueMin = HighIndex;

				NewColorCubeInfo.BlueMax = OldColorCubeInfo.BlueMax;
				OldColorCubeInfo.BlueMax = OldColorCubeInfo.BlueMin + Math.floor(BlueLength / 2.0);
				NewColorCubeInfo.BlueMin = OldColorCubeInfo.BlueMax + 1;
			}
			else
			{
				break;
			}
		}

		ColorCubeInfos[LongestCubeIndex] = TrimColorCube(ColorCube, OldColorCubeInfo);
		//ColorCubeInfos[HeaviestCubeIndex] = TrimColorCube(ColorCube, OldColorCubeInfo);
		ColorCubeInfos.push(TrimColorCube(ColorCube, NewColorCubeInfo));
	}

	return ColorCubeInfos;
}

