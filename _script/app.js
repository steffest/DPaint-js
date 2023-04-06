import UI from "./ui/ui.js";
import EventBus from "./util/eventbus.js";
import {COMMAND, EVENT} from "./enum.js";
import ImageFile from "./image.js";
import Palette from "./ui/palette.js";
import Modal, {DIALOG} from "./ui/modal.js";

let App = function(){
	let me = {
		version: "0.01 alpha"
	}
	
	me.init = function(){
		console.error("init");
		UI.init();
		EventBus.trigger(COMMAND.NEW);

		EventBus.on(COMMAND.OPEN,function(){
			ImageFile.openLocal();
		})

		EventBus.on(COMMAND.LOADPALETTE,()=>{
			Palette.openLocal();
		})

		EventBus.on(COMMAND.ADF,()=>{
			var input = document.createElement('input');
			input.type = 'file';
			input.onchange = function(e){
				let files =  e.target.files;
				console.error(files);
				import("./ui/components/fileBrowser.js").then(FileBrowser=>{
					FileBrowser.default.openAdf(files);
				});
			};
			input.click();



		});

		EventBus.on(COMMAND.ABOUT,()=>{
			Modal.show(DIALOG.ABOUT,me.version);
		})

		EventBus.on(COMMAND.FULLSCREEN,()=>{
			let elm = document.body;
			if (!elm) return;
			if (elm.requestFullscreen) {
				elm.requestFullscreen().catch(
					(err)=>{
						console.error("fullscreen failed");
						console.error(err);
					}
				);
			} else if (elm.webkitRequestFullscreen) { /* Safari */
				elm.webkitRequestFullscreen();
			}
		})

	}

	window.addEventListener('DOMContentLoaded', (event) => {
		me.init();
	});


	// prevent pinch-zoom for iOS Safari
	if (window.GestureEvent) {
		document.documentElement.addEventListener('gesturestart', (e)=>{e.preventDefault()}, {passive: false, capture:true});
	}


/*
	window.test = function(){
		let canvas = ImageFile.getCanvas();
		let ctx = canvas.getContext("2d");

		let imagaDate = canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);

		let transformed = bayer(imagaDate,128);
		//let transformed = atkinson(imagaDate);
		ctx.putImageData(transformed,0,0);


		//effects.outline(ctx,[0,0,0]);
		//effects.feather(ctx,-1);

		//StackBlur.canvasRGBA(canvas,0 ,0,canvas.width,canvas.height,10);
		EventBus.trigger(EVENT.layerContentChanged);


	}


	function bayer(image, threshold) {
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
		}

		return image;
	}

	function floydsteinberg(image) {
		const width = image.width;
		const luminance = new Uint8ClampedArray(image.width * image.height);

		for (let l = 0, i = 0; i < image.data.length; l++, i += 4) {
			luminance[l] = (image.data[i] * 0.299) + (image.data[i + 1] * 0.587) + (image.data[i + 2] * 0.114);
		}

		for (let l = 0, i = 0; i < image.data.length; l++, i += 4) {
			const value = luminance[l] < 129 ? 0 : 255;
			const error = Math.floor((luminance[l] - value) / 16);
			image.data.fill(value, i, i + 3);

			luminance[l + 1] += error * 7;
			luminance[l + width - 1] += error * 3;
			luminance[l + width] += error * 5;
			luminance[l + width + 1] += error * 1;
		}

		return image;
	}

	function atkinson(image) {
		const width = image.width;
		const luminance = new Uint8ClampedArray(image.width * image.height);

		for (let l = 0, i = 0; i < image.data.length; l++, i += 4) {
			luminance[l] = (image.data[i] * 0.299) + (image.data[i + 1] * 0.587) + (image.data[i + 2] * 0.114);
		}

		for (let l = 0, i = 0; i < image.data.length; l++, i += 4) {
			const value = luminance[l] < 129 ? 0 : 255;
			const error = Math.floor((luminance[l] - value) / 8);
			image.data.fill(value, i, i + 3);

			luminance[l + 1] += error;
			luminance[l + 2] += error;
			luminance[l + width - 1] += error;
			luminance[l + width] += error;
			luminance[l + width + 1] += error;
			luminance[l + 2 * width] += error;
		}

		return image;
	}

*/
	
	return me;
}();

