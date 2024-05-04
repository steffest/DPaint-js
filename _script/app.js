import UI from "./ui/ui.js";
import EventBus from "./util/eventbus.js";
import {COMMAND, EVENT} from "./enum.js";
import ImageFile from "./image.js";
import Palette from "./ui/palette.js";
import Modal, {DIALOG} from "./ui/modal.js";
import Brush from "./ui/brush.js";

let App = function(){
	let me = {
		version: "0.1.4.2 alpha"
	}
	
	me.init = function(){
		UI.init();
		EventBus.trigger(COMMAND.NEW);

		let urlParams = new URLSearchParams(window.location.search);

		if (urlParams.has("file")){
			let file = urlParams.get("file");
			if (file){

				if (urlParams.has("presentation")){
					EventBus.trigger(COMMAND.PRESENTATION);
				}

				ImageFile.openUrl(file).then(()=>{
					setTimeout(()=>{
						if (urlParams.has("play")){
							EventBus.trigger(COMMAND.CYCLEPALETTE);
						}
						if (urlParams.has("zoom")){
							EventBus.trigger(COMMAND.ZOOMFIT);
						}
						if (urlParams.has("palette")){
							EventBus.trigger(COMMAND.PALETTEFROMIMAGE);
						}
					},200);
				}).catch((err)=>{});
			}
		}else{
			// show about dialog on first run
			if (window.localStorage.getItem("dp_about")!=="true"){
				setTimeout(()=>{
					EventBus.trigger(COMMAND.ABOUT);
					window.localStorage.setItem("dp_about","true");
				},200);
			}


			if (urlParams.has("gallery")){
				setTimeout(()=>{
					EventBus.trigger(COMMAND.TOGGLEGALLERY,true);
				},200);

			}

			// check for local autoSave
			ImageFile.restoreAutoSave();
		}

		if (window.self !== window.top && window.parent){
			// we are running in an iframe, let's see if we can contact the host
			console.log("contacting host");
			import("./host/host.js").then(host=>{
				window.host = host.default;
				window.host.init();
			});
		}

		EventBus.on(COMMAND.OPEN,function(){
			ImageFile.openLocal();
		})

		EventBus.on(COMMAND.LOADPALETTE,()=>{
			Palette.openLocal();
		})

		EventBus.on(COMMAND.LOADBRUSH,()=>{
			Brush.openLocal();
		})

		EventBus.on(COMMAND.ADF,()=>{
			var input = document.createElement('input');
			input.type = 'file';
			input.onchange = function(e){
				let files =  e.target.files;
				import("./ui/components/fileBrowser.js").then(FileBrowser=>{
					FileBrowser.default.openAdf(files);
				});
			};
			input.click();
		});

		EventBus.on(COMMAND.DELUXE,()=>{
			import("./ui/components/uae.js").then(UAE=>{
				UAE.default.preview();
			});
		});

		EventBus.on(COMMAND.TOGGLEGALLERY,(andOpen)=>{
			import("./ui/components/gallery.js").then(Gallery=>{
				Gallery.default.toggle(andOpen);
			});
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

		EventBus.on(COMMAND.TOGGLEOVERRIDE,()=>{
			window.override = !window.override;
			document.body.classList.toggle("override",window.override);
			EventBus.trigger(EVENT.layersChanged);
		});

	}

	window.addEventListener('DOMContentLoaded', (event) => {
		if (window.location.protocol==="http:" && window.location.hostname.indexOf("stef.be")>=0){
			window.location.href = window.location.href.replace("http:","https:");
		}else{
			me.init();
		}
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

	window.rot = function(){
		import("./paintTools/rotSprite.js").then(async rotSprite=>{
			let canvas = ImageFile.getActiveLayer().getCanvas();
			let c = duplicateCanvas(canvas,true);
			let result = await rotSprite.default(c,90);
			console.log(result);
			console.error("ok");
		});
	}
	*/

	return me;
}();

