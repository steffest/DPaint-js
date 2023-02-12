import {$div} from "../util/dom.js";

let StatusBar = (()=>{
  let me = {};
  let container;
  let toolTip;

  me.init = (parent)=>{
      container = $div("statusbar","",parent);
      toolTip = $div("tooltip","",container);
  }

  me.setToolTip = (text)=>{
    toolTip.innerText = text;
  }

  return me;
})();

export default StatusBar;