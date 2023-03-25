import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Menu from "./menu.js";
import Editor from "./editor.js";
import Statusbar from "./statusbar.js";
import ContextMenu from "./components/contextMenu.js";
import ImageFile from "../image.js";
import Selection from "./selection.js";
import Resizer from "./components/resizer.js";

var Input = function(){
	let me = {}
	let keyDown = {}
	let modifiers = ["space","shift","control","alt"];
	let touchData = {};
	let activeKeyHandler;
	
	me.init = function(){
		console.log("Input init");
		document.addEventListener("mousedown",onMouseDown)
		document.addEventListener("mouseup",onMouseUp)
		document.addEventListener("mousemove",onMouseMove)
		document.addEventListener("touchmove",onMouseMove)
		document.addEventListener("keydown",onKeyDown)
		document.addEventListener("keyup",onKeyUp)

		document.body.oncontextmenu = function(){
			return me.isShiftDown();
		}

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
	me.isMouseDown = function(){
		return document.body.classList.contains("mousedown");
	}

	me.setMouseOver = function(id){
		document.body.classList.add("hover" + id);
	}

	me.removeMouseOver = function(id){
		document.body.classList.remove("hover" + id);
	}

	me.setActiveKeyHandler = function(handler){
		activeKeyHandler = handler;
	}

	me.setDragElement = function(elm,event){
		if (touchData.dragElement) me.removeDragElement();

		touchData.dragElement = document.createElement("div");
		touchData.dragElement.id="dragelement";
		if (elm) touchData.dragElement.appendChild(elm);
		console.error(event);
		document.body.appendChild(touchData.dragElement);
	}

	me.removeDragElement = function(){
		if (touchData.dragElement){
			touchData.dragElement.remove();
			touchData.dragElement = undefined;
		}
	}

	function onMouseDown(e){
		document.body.classList.add("mousedown");
		let target = e.target.closest(".handle");
		console.log(target);

		if (!target || !target.classList.contains("menuitem")){
			Menu.close();
		}
		if (!target || !target.classList.contains("contextmenuitem")){
			ContextMenu.hide();
		}

		if (target){
			if (target.onClick) target.onClick(e);
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


			if (Resizer.isActive()){
				let sizeTarget = target.closest(".sizebox");
				if (!sizeTarget){
					Editor.commit();
				}
			}

		}
	}

	function onMouseMove(e){

		if (!e.shiftKey) keyDown["shift"]=false;
		if (!e.ctrlKey) keyDown["control"]=false;
		if (!e.metaKey) keyDown["meta"]=false;

		let infoTarget = e.target.closest(".info");
		if (infoTarget){
			if (infoTarget.info) Statusbar.setToolTip(infoTarget.info);
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
	}

	function onMouseUp(e){
		if (touchData.isDragging){
			if (touchData.target && touchData.target.onDragEnd){
				touchData.target.onDragEnd(e);
			}
		}
		touchData.isDragging = false;
		document.body.classList.remove("mousedown");
	}

	function onKeyDown(e){
		let code = limitKeyCode(e.code);
		let key = e.key;

		if (me.isShiftDown() && !e.shiftKey) modifierKeyUp("shift");
		if (me.isControlDown() && !e.ctrlKey) modifierKeyUp("control");
		if (me.isAltDown() && !e.altKey) modifierKeyUp("alt");
		if (keyDown["meta"] && !e.metaKey) modifierKeyUp("meta");

		if (code === "keyv" && Input.isMetaDown()){
			// allow default paste
			return;
		}

		if (code === "keyc" && Input.isMetaDown()){
			// allow default copy
			return;
		}

		e.preventDefault();
		e.stopPropagation();
		console.log(e);

		keyDown[code] = true;
		if (modifiers.indexOf(code)>=0){
			document.body.classList.add(code.toLowerCase());
			EventBus.trigger(EVENT.modifierKeyChanged);
		}


		if (activeKeyHandler){
			activeKeyHandler(code);
			return;
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
				break;
			case "tab":
				EventBus.trigger(COMMAND.SPLITSCREEN);
				break;
			case "enter":
				Editor.commit();
				break;
			case "arrowleft":
			case "arrowup":
			case "arrowright":
			case "arrowdown":
				Editor.arrowKey(code.replace("arrow",""));
				break;
		}

		if (me.isMetaDown()){
			switch (key){
				case "a": EventBus.trigger(COMMAND.SELECTALL); break;
				case "b": EventBus.trigger(COMMAND.EFFECTS); break;
				case "d": EventBus.trigger(COMMAND.DUPLICATELAYER); break;
				case "i": EventBus.trigger(COMMAND.INFO); break;
				case "j": EventBus.trigger(COMMAND.TOLAYER); break;
				case "n": EventBus.trigger(COMMAND.NEW); break;
				case "o": EventBus.trigger(COMMAND.OPEN); break;
				case "p": EventBus.trigger(COMMAND.RESIZE); break;
				case "_r": EventBus.trigger(COMMAND.ROTATE); break;
				case "r": EventBus.trigger(COMMAND.RESAMPLE); break;
				case "s": EventBus.trigger(COMMAND.SAVE); break;
				case "t": EventBus.trigger(COMMAND.TRANSFORMLAYER); break;
				case "y": EventBus.trigger(COMMAND.REDO); break;
				case "z": EventBus.trigger(COMMAND.UNDO); break;

			}
		}else{
			switch (key){
				case "b": EventBus.trigger(COMMAND.DRAW); break;
				case "c": EventBus.trigger(COMMAND.CIRCLE); break;
				case "e": EventBus.trigger(COMMAND.ERASE); break;
				case "g": EventBus.trigger(COMMAND.GRADIENT); break;
				case "l": EventBus.trigger(COMMAND.LINE); break;
				case "p": EventBus.trigger(COMMAND.POLYGONSELECT); break;
				case "r": EventBus.trigger(COMMAND.SQUARE); break;
				case "s": EventBus.trigger(COMMAND.SELECT); break;
				case "v": EventBus.trigger(COMMAND.TRANSFORMLAYER); break;
				case "x": EventBus.trigger(COMMAND.SWAPCOLORS); break;
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
				ImageFile.paste(img);
			}
			img.src = URL.createObjectURL(blob);
		}

		if (!e){
			// "paste" seledcted from menu;

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
		}

		let canvas = Selection.toCanvas() || ImageFile.getActiveContext().canvas;
		if (canvas && ClipboardItem){
			canvas.toBlob((blob) => {
				// note: As to date, FireFox doesn't support ClipboardItem.
				let data = [new ClipboardItem({ [blob.type]: blob })];

				navigator.clipboard.write(data).then(
					() => {
						console.error("copied");
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
		console.error("cut");
	}

	function handleUndo(){
		console.error("undo");
	}

	function handleDelete(){
		console.error("delete");
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