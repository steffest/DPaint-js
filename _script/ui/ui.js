import Input from "./input.js";
import {$div} from "../util/dom.js";
import Menu from "./menu.js";
import Toolbar from "./toolbar.js";
import Editor from "./editor.js";
import Cursor from "./cursor.js";
import Sidepanel from "./sidepanel.js";

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
		Sidepanel.init(container);
		Editor.init(container);
	}
	
	return me;
}();

export default UI;