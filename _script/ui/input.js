var Input = function(){
	let me = {}
	let keyDown = {}
	let modifiers = ["space","shift"];
	let touchData = {};
	
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

	me.setMouseOver = function(id){
		document.body.classList.add("hover" + id);
	}

	me.removeMouseOver = function(id){
		document.body.classList.remove("hover" + id);
	}
	

	function onMouseDown(e){
		document.body.classList.add("mousedown");
		let target = e.target.closest(".handle");
		console.log(target);
		if (target){
			if (target.onClick) target.onClick(e);
			if (target.onDrag){
				console.error("drag");
				touchData.onDrag = target.onDrag;
				touchData.isDraging = true;
				touchData.startX = e.clientX;
				touchData.startY = e.clientY;
			}
		}
	}

	function onMouseMove(e){
		if (touchData.isDraging && touchData.onDrag){
			let x = e.clientX-touchData.startX;
			let y = e.clientY-touchData.startY;
			touchData.onDrag(x,y);
		}
	}

	function onMouseUp(e){
		touchData.isDraging = false;
		document.body.classList.remove("mousedown");
	}

	function onKeyDown(e){
		e.preventDefault();
		let code = limitKeyCode(e.code);
		keyDown[code] = true;
		if (modifiers.indexOf(code)>=0){
			document.body.classList.add(code.toLowerCase());
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
		return code.toLowerCase();
	}
	
	return me;
}();

export default Input;