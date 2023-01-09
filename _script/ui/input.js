import EventBus from "../util/eventbus.js";
import {COMMAND} from "../enum.js";
import Menu from "./menu.js";

var Input = function(){
	let me = {}
	let keyDown = {}
	let modifiers = ["space","shift",,"control"];
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
	me.isMetaDown = function(){
		return !!keyDown["meta"] || me.isControlDown() || me.isShiftDown();
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
	

	function onMouseDown(e){
		document.body.classList.add("mousedown");
		let target = e.target.closest(".handle");
		console.log(target);

		if (!target || !target.classList.contains("menuitem")){
			Menu.close();
		}

		if (target){
			if (target.onClick) target.onClick(e);
			if (target.onDrag){
				touchData.target = target;
				touchData.onDrag = target.onDrag;
				touchData.isDragging = true;
				touchData.startX = e.clientX;
				touchData.startY = e.clientY;
			}
		}
	}

	function onMouseMove(e){
		if (touchData.isDragging && touchData.onDrag){
			let x = e.clientX-touchData.startX;
			let y = e.clientY-touchData.startY;
			touchData.onDrag(x,y);
		}
	}

	function onMouseUp(e){
		if (touchData.isDragging){
			if (touchData.target && touchData.target.onDragEnd){
				touchData.target.onDragEnd();
			}
		}
		touchData.isDragging = false;
		document.body.classList.remove("mousedown");
	}

	function onKeyDown(e){
		e.preventDefault();
		e.stopPropagation();
		let code = limitKeyCode(e.code);
		let key = e.key;
		keyDown[code] = true;
		if (modifiers.indexOf(code)>=0){
			document.body.classList.add(code.toLowerCase());
		}
		console.log(code);

		if (activeKeyHandler){
			activeKeyHandler(code);
			return;
		}

		switch (code){
			case "delete":
			case "backspace":
				EventBus.trigger(COMMAND.CLEAR);
				break;
			case "escape":
				EventBus.trigger(COMMAND.CLEARSELECTION);
				break;
		}

		if (me.isMetaDown()){
			switch (key){
				case "n": EventBus.trigger(COMMAND.NEW); break;
				case "o": EventBus.trigger(COMMAND.OPEN); break;
				case "r": EventBus.trigger(COMMAND.ROTATE); break;
				case "s": EventBus.trigger(COMMAND.SAVE); break;
				case "z": EventBus.trigger(COMMAND.UNDO); break;
				case "y": EventBus.trigger(COMMAND.REDO); break;
			}
		}
	}

	function onKeyUp(e){
		let code = limitKeyCode(e.code);
		keyDown[code] = false;
		if (modifiers.indexOf(code)>=0){
			document.body.classList.remove(code);
		}
	}

	function limitKeyCode(code){
		if ((code === "ShiftLeft") || (code === "ShiftRight")) code = "shift";
		if ((code === "ControlLeft") || (code === "ControlRight")) code = "control";
		if ((code === "MetaLeft") || (code === "MetaRight")) code = "meta";
		return code.toLowerCase();
	}
	
	return me;
}();

export default Input;