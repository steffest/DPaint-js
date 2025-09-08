import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {EVENT} from "../enum.js";

let StatusBar = (()=>{
  let me = {};
  let container;
  let toolTip;
  let permaTip;
  let overide = false;

  me.init = (parent)=>{
      container = $div("statusbar","",parent);
      permaTip = $div("permatip","",container);
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

  EventBus.on(EVENT.penOnlyChanged, (active)=>{
    permaTip.innerHTML = active?"pen mode":"";
    permaTip.classList.toggle("active",active);
  })

  return me;
})();

export default StatusBar;