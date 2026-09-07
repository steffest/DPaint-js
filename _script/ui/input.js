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
import ToolOptions from "./components/toolOptions.js";
import VectorTool from "../paintTools/vectorTool.js";

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
		document.addEventListener("touchmove",onTouchMove, { passive: false })
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
		if (touchData.isDragging && touchData.onDrag){
			e.preventDefault();
		}
	}

	function onTouchEnd(e){
		touchData.touches = e.touches;
		if (e.touches.length===0) holdPointerEvents = false;
	}

	function handlePointerDown(e,target){
		if (holdPointerEvents) return;
		document.body.classList.add("pointerdown");

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
			if (Input.isMetaDown()){
				if (code === "keyc" || code === "keyx" || code === "keyv"){
					// If an editable element (input/textarea/code) is focused, let the browser
					// handle copy/cut/paste natively so normal text editing keeps working.
					if (isEditableTarget(document.activeElement)) return;

					// Otherwise route copy/paste through the async Clipboard API from THIS keydown
					// gesture. We must not let the native "copy"/"paste" events fire: Safari throws
					// NotAllowedError when navigator.clipboard.* is called inside those events.
					if (code === "keyc"){
						e.preventDefault();
						EventBus.trigger(COMMAND.COPY);
						return;
					}
					if (code === "keyv"){
						e.preventDefault();
						EventBus.trigger(COMMAND.PASTE);
						return;
					}
					// cut (keyx): keep default browser behaviour
					return;
				}

				if (code === "keyq"){
					// allow default quit
					//console.error("quit");
					//return;
				}
			}
		}

		e.preventDefault();
		e.stopPropagation();

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
				// on a vector layer, Delete removes the selected point/shape instead of clearing pixels
				if (VectorTool.isActive()){
					EventBus.trigger(COMMAND.VECTORDELETE);
				}else{
					EventBus.trigger(COMMAND.CLEAR);
				}
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
				if (me.isShiftDown()){
					EventBus.trigger(COMMAND.CYCLEPALETTESTEP);
				}else{
					EventBus.trigger(COMMAND.CYCLEPALETTE);
				}
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
					case "i": EventBus.trigger(COMMAND.INVERTSELECTION); break;
					case "l": EventBus.trigger(COMMAND.TOSELECTION); break;
					case "p": EventBus.trigger(COMMAND.COLORSELECT); break;
					case "r": EventBus.trigger(COMMAND.TOGGLERULERS); break;
					case "x": EventBus.trigger(COMMAND.INFO); break;
					case "arrowdown": EventBus.trigger(COMMAND.MERGEDOWN); break;
				}
			}else{
				switch (key){
					// on a vector layer, select all points & lines instead of the pixel rectangle
					case "a":
						if (VectorTool.isActive() && VectorTool.selectAll()) break;
						EventBus.trigger(COMMAND.SELECTALL);
						break;
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
		}else if (VectorTool.isActive() && handleVectorToolKey(key)){
			// on a vector layer the single-letter tool keys switch the vector SUB-tool (S/L/R/C/B/F/O)
			// instead of the pixel tools; any key the vector map doesn't claim falls through below.
		}else{
			switch (key){
				//case "a": EventBus.trigger(COMMAND.TOGGLEMASK); break;
				case "a": EventBus.trigger(COMMAND.ARC); break;
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
				case "m": EventBus.trigger(COMMAND.SMUDGE); break;
				case "n": EventBus.trigger(COMMAND.SPLITSCREEN); break;
				case "o": EventBus.trigger(COMMAND.SPRAY); break;
				case "p": EventBus.trigger(COMMAND.POLYGONSELECT); break;
				case "q": EventBus.trigger(COMMAND.TOGGLEOVERRIDE); break;
				case "r": EventBus.trigger(COMMAND.SQUARE); break;
				case "s":
					if ((Editor.getCurrentTool() === COMMAND.LINE || Editor.getCurrentTool() === COMMAND.ARC || Editor.getCurrentTool() === COMMAND.CIRCLE) && Editor.isDrawing()){
						ToolOptions.toggleSmooth();
					}else{
						EventBus.trigger(COMMAND.SELECT);
					}
					break;
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

	// Vector-mode single-letter tool shortcuts. Mirrors the pixel-tool keys but switches the active
	// VectorTool sub-mode (the command also re-highlights the matching toolbar button). Returns true
	// when the key maps to a vector tool so the caller can skip the pixel-tool switch; false lets keys
	// the vector tool doesn't use (undo, zoom, pan, colour-pick, …) fall through to the normal handler.
	function handleVectorToolKey(key){
		switch (key){
			case "s": EventBus.trigger(COMMAND.VECTORSELECT); return true;  // Select / edit
			case "l": EventBus.trigger(COMMAND.VECTORLINE); return true;    // Line
			case "r": EventBus.trigger(COMMAND.VECTORRECT); return true;    // Rectangle
			case "c": EventBus.trigger(COMMAND.VECTORCIRCLE); return true;  // Circle / ellipse
			case "b": EventBus.trigger(COMMAND.VECTORBLOB); return true;    // Blob brush
			case "f": EventBus.trigger(COMMAND.VECTORFILL); return true;    // Fill
			case "o": EventBus.trigger(COMMAND.VECTOROUTLINE); return true; // Outline / stroke
		}
		return false;
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

	function isEditableTarget(el){
		if (!el) return false;
		const tag = el.tagName ? el.tagName.toLowerCase() : "";
		return tag === "input" || tag === "textarea" || el.isContentEditable || !!(el.closest && el.closest("code"));
	}

	function handlePaste(e){

		// Let editable elements handle paste natively (e.g. the filename field in dialogs).
		if (e && isEditableTarget(e.target)) return;

		// On a vector layer, if we hold an internal vector-point selection, paste it as a detached
		// floating copy on the same layer (spec 014) instead of pasting a raster image.
		if (VectorTool.isActive() && VectorTool.hasClipboard()){
			if (VectorTool.pasteFloating()) return;
		}

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
			// "paste" selected from menu or triggered via the Cmd/Ctrl+V keyboard gesture.
			// Read the clipboard directly inside the gesture. We deliberately do NOT use
			// navigator.permissions.query({name:'clipboard-read'}): Safari doesn't support that
			// permission name and rejects with a TypeError (the "unhandled promise rejection").
			if (navigator.clipboard && navigator.clipboard.read){
				navigator.clipboard.read().then(async (clipboardItems)=>{
					for (const clipboardItem of clipboardItems){
						for (const type of clipboardItem.types){
							if (type.indexOf("image") !== -1){
								const blob = await clipboardItem.getType(type);
								pasteImage(blob);
								return;
							}
						}
					}
				}).catch(err=>{
					console.error(err.name, err.message);
				});
			}
			return;
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
			if (e.target.tagName.toLowerCase() === "textarea") return;
			if (e.target.closest("code")) return;
		}

		// On a vector layer, a point/line/shape selection copies into the internal vector clipboard
		// (spec 014) so Cmd-V can duplicate it on the same layer. Skip the raster copy when it took.
		if (VectorTool.isActive() && VectorTool.copySelection()) return;

		let canvas = Selection.toCanvas() || ImageFile.getActiveContext().canvas;
		if (canvas && ClipboardItem){
			// note: As to date, FireFox doesn't support ClipboardItem.
			// Safari requires clipboard.write() to be called synchronously within the user gesture
			// and does not support Promise values in ClipboardItem before Safari 16.4.
			// Use toDataURL() to build the Blob synchronously so the entire write is in-gesture.
			const dataUrl = canvas.toDataURL("image/png");
			const binary = atob(dataUrl.split(",")[1]);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			const blob = new Blob([bytes], {type: "image/png"});
			const data = [new ClipboardItem({"image/png": blob})];
			navigator.clipboard.write(data).then(
				() => {
					console.log("copied");
				},
				(err) => {
					console.error("error");
					console.error(err);
				}
			);
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
