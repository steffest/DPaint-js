import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Menu from "./menu.js";
import Editor from "./editor.js";
import Statusbar from "./statusbar.js";
import ContextMenu from "./components/contextMenu.js";
import ImageFile from "../image.js";
import Selection from "./selection.js";
import Cursor from "./cursor.js";
import UI from "./ui.js";
import Palette from "./palette.js";

var Input = function(){
	let me = {}
	let keyDown = {}
	let modifiers = ["space","shift","control","alt"];
	let touchData = {};
	let activeKeyHandler;
	let holdPointerEvents = false;
	
	me.init = function(){
		console.log("Input init");
		document.addEventListener("pointerdown",onPointerDown)
		document.addEventListener("pointerup",onPointerUp)
		document.addEventListener("pointercancel",onPointerUp)
		//document.addEventListener("pointerout",onPointerUp)
		document.addEventListener("pointerleave",onPointerUp)
		document.addEventListener("pointermove",onPointerMove)

		document.addEventListener("touchstart",onTouchStart)
		document.addEventListener("touchmove",onTouchMove)
		document.addEventListener("touchend",onTouchEnd)

		document.addEventListener("keydown",onKeyDown)
		document.addEventListener("keyup",onKeyUp)

		document.body.oncontextmenu = function(e){return me.isShiftDown() && !(e.target && e.target.classList.contains("maincanvas"));}


		window.addEventListener("paste", handlePaste,false);
		window.addEventListener("copy", handleCopy,false);
		window.addEventListener("cut", handleCut,false);
		window.addEventListener("undo", handleUndo,false);
		window.addEventListener("delete", handleDelete,false);
		window.addEventListener("dragenter", handleDragEnter,false);
		window.addEventListener("dragover", handleDragOver,false);
		window.addEventListener("drop", handleDrop,false);

		EventBus.on(COMMAND.COPY,handleCopy);
		EventBus.on(COMMAND.PASTE,handlePaste);
	}

	me.isSpaceDown = function(){
		return !!keyDown["space"];
	}
	me.isShiftDown = function(){
		return !!keyDown["shift"];
	}
	me.isControlDown = function(){
		return !!keyDown["control"];
	}
	me.isAltDown = function(){
		return !!keyDown["alt"];
	}
	me.isMetaDown = function(){
		return !!keyDown["meta"] || me.isControlDown() || me.isShiftDown();
	}
	me.isMetaAndShiftDown = function(){
		return (!!keyDown["meta"] || me.isControlDown()) && me.isShiftDown();
	}
	me.isPointerDown = function(){
		return document.body.classList.contains("pointerdown");
	}

	me.setPointerOver = function(id){
		document.body.classList.add("hover" + id);
	}

	me.removePointerOver = function(id){
		document.body.classList.remove("hover" + id);
	}

	me.setActiveKeyHandler = function(handler){
		activeKeyHandler = handler;
	}

	me.setDragElement = function(elm,activate){
		if (touchData.dragElement) me.removeDragElement();

		touchData.dragElement = document.createElement("div");
		touchData.dragElement.id="dragelement";
		if (activate){
			touchData.dragElement.classList.add("active");
			let pos = Cursor.getPosition();
			touchData.dragElement.style.left =  pos.x  + "px";
			touchData.dragElement.style.top =  pos.y  + "px";
		}
		if (elm) touchData.dragElement.appendChild(elm);
		document.body.appendChild(touchData.dragElement);
	}

	me.removeDragElement = function(){
		if (touchData.dragElement){
			touchData.dragElement.remove();
			touchData.dragElement = undefined;
		}
	}

	me.holdPointerEvents = function(){
		holdPointerEvents = true;
	}

	me.releasePointerEvents = function(){
		holdPointerEvents = false;
	}

	me.hasPointerEvents = function(){
		return !holdPointerEvents;
	}

	me.getTouches = function(){
		return touchData.touches || [];
	}

	me.isMultiTouch = function(){
		return me.getTouches().length>1;
	}

	function onPointerDown(e){
		if (holdPointerEvents) return;
		let target = e.target.closest(".handle");

		if (e.pointerType === "touch" && target && target.classList.contains("viewport")){
			// add a small delay so we still can capture multi touch gestures
			setTimeout(function(){
				handlePointerDown(e,target);
			},100);
			return;
		}

		handlePointerDown(e,target);
	}

	function onTouchStart(e){
		touchData.touches = e.touches;
		if (e.touches.length>1){
			console.log("multitouch detected, holding pointer events");
			holdPointerEvents = true;
			EventBus.trigger(EVENT.hideCanvasOverlay);
		}
	}

	function onTouchMove(e){
		touchData.touches = e.touches;
	}

	function onTouchEnd(e){
		touchData.touches = e.touches;
		if (e.touches.length===0) holdPointerEvents = false;
	}

	function handlePointerDown(e,target){
		if (holdPointerEvents) return;
		document.body.classList.add("pointerdown");
		console.log(target);

		if (!target || !target.classList.contains("menuitem")){
			Menu.close();
		}
		if (!target || !target.classList.contains("contextmenuitem")){
			ContextMenu.hide();
		}

		if (target){

			let resizer = Editor.getActivePanel().getResizer();
			if (resizer.isActive()){
				let sizeTarget = target.closest(".sizebox");
				if (!sizeTarget){
					Editor.commit();
				}
			}

			if (target.onClick){
				// on touch devices this is not a click, which might interfere with events that require "user input"
				// like the file input dialog to open a file

				if ((e.pointerType==="touch" || e.pointerType==="pen") && target.waitForClick){
					touchData.waitForClick = {
						target: target,
						event: e,
						time: performance.now()
					}
				}else {
					target.onClick(e,target);
				}
			}


			if (target.onDoubleClick){
				let now = performance.now();
				if (target.prevNow){
					if((now - target.prevNow)<400){
						target.onDoubleClick();
					}
				}
				target.prevNow = now;
			}
			if (target.onDrag){
				touchData.target = target;
				touchData.onDrag = target.onDrag;
				touchData.isDragging = true;
				touchData.startX = e.clientX;
				touchData.startY = e.clientY;
				touchData.button = e.button;
				e.preventDefault();
				if (target.onDragStart) target.onDragStart(e);
			}
			if ((e.button || e.ctrlKey) && target.onContextMenu){
				target.onContextMenu(e);
			}

		}
	}

	function onPointerMove(e){
		if (holdPointerEvents) return;
		if (!e.shiftKey) keyDown["shift"]=false;
		if (!e.altKey) keyDown["alt"]=false;
		if (!e.ctrlKey) keyDown["control"]=false;
		if (!e.metaKey) keyDown["meta"]=false;

		let infoTarget = e.target.closest(".info");
		if (infoTarget){
			let tooltip = infoTarget.info;
			if (infoTarget.infoOnMove) tooltip = infoTarget.infoOnMove(e) + infoTarget.info;
			if (infoTarget.info) Statusbar.setToolTip(tooltip);
		}else{
			Statusbar.setToolTip("");
		}

		if (touchData.isDragging && touchData.onDrag){
			let x = e.clientX-touchData.startX;
			let y = e.clientY-touchData.startY;
			touchData.onDrag(x,y,touchData,e);
		}
		if (touchData.dragElement){
			touchData.dragElement.classList.add("active");
			touchData.dragElement.style.left =  e.clientX  + "px";
			touchData.dragElement.style.top =  e.clientY  + "px";
		}

		// Meh ...
		if (!me.isShiftDown() && !me.isAltDown() && !me.isSpaceDown() && !document.body.classList.contains("cursor-pan")){
			Cursor.resetOverride();
		}
	}

	function onPointerUp(e){
		if (e.button===1 && document.body.classList.contains("cursor-pan")){
			Cursor.resetOverride();
		}

		if (touchData.waitForClick){
			let now = performance.now();
			if ((now - touchData.waitForClick.time)<2000){
				touchData.waitForClick.target.onClick(touchData.waitForClick.event);
			}else{
				console.log("waitForClick timeout");
			}
			touchData.waitForClick = undefined;
		}


		if (touchData.isDragging){
			if (touchData.target && touchData.target.onDragEnd){
				touchData.target.onDragEnd(e);
			}
		}
		touchData.isDragging = false;
		document.body.classList.remove("pointerdown");

		if (document.body.classList.contains("colorpicker") && !me.isShiftDown() && !me.isAltDown()){
			//Cursor.reset();
		}

	}

	function onKeyDown(e){
		let code = limitKeyCode(e.code);
		let key = e.key;
		if (key) key = key.toLowerCase();

		if (me.isShiftDown() && !e.shiftKey) modifierKeyUp("shift");
		if (me.isControlDown() && !e.ctrlKey) modifierKeyUp("control");
		if (me.isAltDown() && !e.altKey) modifierKeyUp("alt");
		if (keyDown["meta"] && !e.metaKey) modifierKeyUp("meta");

		if (Editor.getCurrentTool() !== COMMAND.TEXT){
			if (code === "keyv" && Input.isMetaDown()){
				// allow default paste
				return;
			}

			if (code === "keyc" && Input.isMetaDown()){
				// allow default copy
				return;
			}
		}

		e.preventDefault();
		e.stopPropagation();
		//                                                      console.log(e);

		keyDown[code] = true;
		if (modifiers.indexOf(code)>=0){
			document.body.classList.add(code.toLowerCase());
			EventBus.trigger(EVENT.modifierKeyChanged);
		}


		if (activeKeyHandler){
			let handled = activeKeyHandler(code,key);
			if (handled) return;
		}

		//console.log(code);
		switch (code){
			case "delete":
			case "backspace":
				EventBus.trigger(COMMAND.CLEAR);
				break;
			case "escape":
				// TODO should we tie this to the selected tool?
				Menu.close();
				ContextMenu.hide();
				Editor.reset();
				if (UI.inPresentation()) EventBus.trigger(COMMAND.PRESENTATION);
				break;
			case "tab":
				//EventBus.trigger(COMMAND.SPLITSCREEN);
				EventBus.trigger(COMMAND.CYCLEPALETTE);
				break;
			case "enter":
				Editor.commit();
				break;
			case "numpad4":
				ImageFile.nextFrame(-1);
				break;
			case "numpad6":
				ImageFile.nextFrame();
				break;
			case "numpad7":
				Palette.prev();
				break;
			case "numpad9":
				Palette.next();
				break;
			case "intlbackslash":
				if (me.isShiftDown()){
					ImageFile.nextFrame();
				}else{
					ImageFile.nextFrame(-1);
				}
				break;
			case "arrowleft":
			case "arrowup":
			case "arrowright":
			case "arrowdown":
				Editor.arrowKey(code.replace("arrow",""));
				break;
			case "pageup":
				EventBus.trigger(COMMAND.NEXTPALETTE);
				break;
			case "pagedown":
				EventBus.trigger(COMMAND.PREVPALETTE);
				break;
		}

		if (me.isMetaDown()){

			if (me.isMetaAndShiftDown()){
				switch (key){
					case "a": EventBus.trigger(COMMAND.LAYERMASK); break;
					case "f": EventBus.trigger(COMMAND.FLATTEN); break;
					case "h": EventBus.trigger(COMMAND.LAYERMASKHIDE); break;
					case "l": EventBus.trigger(COMMAND.TOSELECTION); break;
					case "p": EventBus.trigger(COMMAND.COLORSELECT); break;
					case "x": EventBus.trigger(COMMAND.INFO); break;
					case "arrowdown": EventBus.trigger(COMMAND.MERGEDOWN); break;
				}
			}else{
				switch (key){
					case "a": EventBus.trigger(COMMAND.SELECTALL); break;
					case "b": EventBus.trigger(COMMAND.STAMP); break;
					case "d": EventBus.trigger(COMMAND.DUPLICATELAYER); break;
					case "e": EventBus.trigger(COMMAND.EFFECTS); break;
					case "g": EventBus.trigger(COMMAND.TOGGLEGRID); break;
					case "i": EventBus.trigger(COMMAND.IMPORTLAYER); break;
					case "j": EventBus.trigger(COMMAND.TOLAYER); break;
					case "k": EventBus.trigger(COMMAND.CUTTOLAYER); break;
					case "l": EventBus.trigger(COMMAND.TOLAYER); break;
					case "n": EventBus.trigger(COMMAND.NEW); break;
					case "o": EventBus.trigger(COMMAND.OPEN); break;
					case "p": EventBus.trigger(COMMAND.RESIZE); break;
					case "_r": EventBus.trigger(COMMAND.ROTATE); break;
					case "r": EventBus.trigger(COMMAND.RESAMPLE); break;
					case "s": EventBus.trigger(COMMAND.SAVE); break;
					case "y": EventBus.trigger(COMMAND.REDO); break;
					case "z": EventBus.trigger(COMMAND.UNDO); break;
				}
			}
		}else{
			switch (key){
				case "a": EventBus.trigger(COMMAND.TOGGLEMASK); break;
				case "b": EventBus.trigger(COMMAND.DRAW); break;
				case "c": EventBus.trigger(COMMAND.CIRCLE); break;
				case "d": EventBus.trigger(COMMAND.TOGGLEDITHER); break;
				case "e": EventBus.trigger(COMMAND.ERASE); break;
				case "f": EventBus.trigger(COMMAND.FLOOD); break;
				case "g": EventBus.trigger(COMMAND.GRADIENT); break;
				case "h": EventBus.trigger(COMMAND.PAN); break;
				case "i": EventBus.trigger(COMMAND.TOGGLEINVERT); break;
				case "k": EventBus.trigger(COMMAND.COLORPICKER); break;
				case "l": EventBus.trigger(COMMAND.LINE); break;
				case "m": EventBus.trigger(COMMAND.SMUDGE); break;n
				case "n": EventBus.trigger(COMMAND.SPLITSCREEN); break;
				case "p": EventBus.trigger(COMMAND.SPRAY); break;
				case "q": EventBus.trigger(COMMAND.TOGGLEOVERRIDE); break;
				case "r": EventBus.trigger(COMMAND.SQUARE); break;
				case "s": EventBus.trigger(COMMAND.SELECT); break;
				case "t": EventBus.trigger(COMMAND.TEXT); break;
				case "v": EventBus.trigger(COMMAND.TRANSFORMLAYER); break;
				case "w": EventBus.trigger(COMMAND.FLOODSELECT); break;
				case "x": EventBus.trigger(COMMAND.SWAPCOLORS); break;
				case "y": EventBus.trigger(COMMAND.POLYGONSELECT); break;
				case "z": EventBus.trigger(COMMAND.UNDO); break;
				case "-": EventBus.trigger(COMMAND.ZOOMOUT); break;
				case "+": EventBus.trigger(COMMAND.ZOOMIN); break;
			}
		}

	}

	function onKeyUp(e){
		let code = limitKeyCode(e.code);
		keyDown[code] = false;
		if (modifiers.indexOf(code)>=0){
			modifierKeyUp(code);
		}
	}

	function modifierKeyUp(code){
		keyDown[code] = false;
		document.body.classList.remove(code);
		EventBus.trigger(EVENT.modifierKeyChanged);
	}

	function limitKeyCode(code){
		if ((code === "ShiftLeft") || (code === "ShiftRight")) code = "shift";
		if ((code === "AltLeft") || (code === "AltRight")) code = "alt";
		if ((code === "ControlLeft") || (code === "ControlRight")) code = "control";
		if ((code === "MetaLeft") || (code === "MetaRight")) code = "meta";
		return code.toLowerCase();
	}

	function handlePaste(e){

		function pasteImage(blob){
			let img = new Image();
			img.onerror = ()=>{
				console.error("error pasting image");
			}
			img.onload = ()=>{
				console.log("pasted image", img.width, img.height);
				ImageFile.paste(img);
			}
			img.src = URL.createObjectURL(blob);
		}

		if (!e){
			// "paste" selected from menu;

			let blob;
			const queryOpts = { name: 'clipboard-read', allowWithoutGesture: true };
			navigator.permissions.query(queryOpts).then(permissionStatus=>{
				// Will be 'granted', 'denied' or 'prompt':
				console.log(permissionStatus.state);
				getClipboardContents();

				// Listen for changes to the permission state
				permissionStatus.onchange = () => {
					console.log(permissionStatus.state);
					getClipboardContents();
				};


				async function getClipboardContents() {
					if (permissionStatus.state === "granted") {
						try {
							const clipboardItems = await navigator.clipboard.read();
							for (const clipboardItem of clipboardItems) {
								for (const type of clipboardItem.types) {
									if (!blob && type.indexOf('image') !== -1){
										blob = await clipboardItem.getType(type);
										pasteImage(blob);
									}
								}
							}
						} catch (err) {
							console.error(err.name, err.message);
						}
					}
				}
			})
		}
		console.log("paste",e);
		if (e && e.clipboardData){
			const clipboardItems = e.clipboardData.items;
			console.log("paste " + clipboardItems.length + " items");
			let list = [].slice.call(clipboardItems);
			list.forEach(item=>{
				console.log(item.type);
			});

			const items = list.filter(function (item) {
				// Filter the image items only
				return item.type.indexOf('image') !== -1;
			});
			if (items.length === 0) {
				return;
			}

			const item = items[0];
			// Get the blob of image
			console.log("paste " + item.type)
			const blob = item.getAsFile();
			pasteImage(blob)
		}
	}

	function handleCopy(e){
		if (e){
			// Check what we need to copy
			console.log("copy from ", e.target,e);

			// allow default copy for input fields
			if (e.target.tagName.toLowerCase() === "input") return;
			if (e.target.closest("code")) return;
		}

		let canvas = Selection.toCanvas() || ImageFile.getActiveContext().canvas;
		if (canvas && ClipboardItem){
			canvas.toBlob((blob) => {
				// note: As to date, FireFox doesn't support ClipboardItem.
				let data = [new ClipboardItem({ [blob.type]: blob })];

				navigator.clipboard.write(data).then(
					() => {
						console.log("copied");
					},
					(err) => {
						console.error("error");
						console.error(err);
						//onError(err);
					}
				);
			});
		}
	}

	function handleCut(){
		console.log("cut");
	}

	function handleUndo(){
		console.log("undo");
	}

	function handleDelete(){
		console.log("delete");
	}

	function handleDragEnter(e) {
		e.stopPropagation();
		e.preventDefault();
	}

	function handleDragOver(e){
		e.stopPropagation();
		e.preventDefault();
	}

	function handleDrop(e){
		e.preventDefault();
		//console.error("Drop");
		//console.error(e);

		var dt = e.dataTransfer;
		var files = dt.files;

		ImageFile.handleUpload(files,"file")

	}
	
	return me;
}();

export default Input;