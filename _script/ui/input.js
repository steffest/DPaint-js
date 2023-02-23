import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Menu from "./menu.js";
import Editor from "./editor.js";
import Statusbar from "./statusbar.js";
import ContextMenu from "./components/contextMenu.js";

var Input = function(){
	let me = {}
	let keyDown = {}
	let modifiers = ["space","shift","control"];
	let touchData = {};
	let activeKeyHandler;
	
	me.init = function(){
		console.log("Input init");
		document.addEventListener("mousedown",onMouseDown)
		document.addEventListener("mouseup",onMouseUp)
		document.addEventListener("mousemove",onMouseMove)
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
				e.preventDefault();
				if (target.onDragStart) target.onDragStart(e);
			}
			if ((e.button || e.ctrlKey) && target.onContextMenu){
				target.onContextMenu(e);
			}

		}
	}

	function onMouseMove(e){
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
		if (keyDown["meta"] && !e.metaKey) modifierKeyUp("meta");

		if (code === "keyv" && Input.isMetaDown()){
			// allow default paste
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
				EventBus.trigger(COMMAND.CLEARSELECTION);
				Menu.close();
				ContextMenu.hide();
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
		if ((code === "ControlLeft") || (code === "ControlRight")) code = "control";
		if ((code === "MetaLeft") || (code === "MetaRight")) code = "meta";
		return code.toLowerCase();
	}

	function handlePaste(){
		console.error("paste");
	}

	function handleCopy(){
		console.error("copy");
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
	
	return me;
}();

export default Input;