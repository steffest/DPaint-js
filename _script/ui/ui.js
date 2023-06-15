import Input from "./input.js";
import {$div} from "../util/dom.js";
import Menu from "./menu.js";
import Toolbar from "./toolbar.js";
import Editor from "./editor.js";
import Cursor from "./cursor.js";
import Sidepanel from "./sidepanel.js";
import StatusBar from "./statusbar.js";
import PaletteList from "./components/paletteList.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";

let UI = function(){
	let me = {}
	let container;
	
	me.init = function(){
		container = $div("container");
		document.body.appendChild(container);
		Cursor.init();
		Input.init();
		Menu.init(container);
		Toolbar.init(container);
		StatusBar.init(container);
		Sidepanel.init(container);
		PaletteList.init(container);
		Editor.init(container);

		window.addEventListener("resize",()=>{
			EventBus.trigger(EVENT.UIresize);
		},{passive:true});
	}

	me.fuzzy = function(value){
		if (container) container.classList.toggle("fuzzy",value)
	}


	me.getContainer = function(){
		return container;
	}

	me.inPresentation = function(){
		return document.body.classList.contains("presentation");
	}

	EventBus.on(COMMAND.PRESENTATION,()=>{
		document.body.classList.toggle("presentation");
	})
	
	return me;
}();

export default UI;