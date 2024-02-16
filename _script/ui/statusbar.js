import {$div} from "../util/dom.js";

let StatusBar = (()=>{
  let me = {};
  let container;
  let toolTip;
  let overide = false;

  me.init = (parent)=>{
      container = $div("statusbar","",parent);
      toolTip = $div("tooltip","",container);
  }

  me.setToolTip = (text)=>{
    if (overide) return;
    toolTip.innerHTML = text;
  }

  me.overideToolTip = (text)=>{
    overide = true;
    toolTip.innerHTML = text;
  }

  return me;
})();

export default StatusBar;