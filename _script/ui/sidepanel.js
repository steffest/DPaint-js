import {COMMAND} from "../enum.js";
import {$div} from "../util/dom.js";

var SidePanel = function(){
    let me = {}
    let container;
    
    me.init = function(parent){
        container = $div("sidepanel");
        parent.appendChild(container);
        generate();
    }
    
    function generate(){
        
    }
    
    return me;
}()

export default SidePanel;