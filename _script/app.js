import UI from "./ui/ui.js";
import EventBus from "./util/eventbus.js";
import {COMMAND} from "./enum.js";
import ImageFile from "./image.js";

let App = function(){
	let me = {}
	
	me.init = function(){
		UI.init();
		EventBus.trigger(COMMAND.NEW);

		EventBus.on(COMMAND.OPEN,function(){
			ImageFile.openLocal();
		})
	}

	window.addEventListener('DOMContentLoaded', (event) => {
		me.init();
	});
	
	return me;
}();

