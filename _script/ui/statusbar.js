import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {EVENT, COMMAND} from "../enum.js";

let StatusBar = (()=>{
  let me = {};
  let container;
  let toolTip;
  let permaTip;
  let permaTips = {}
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
    permaTips.pen = active;
    setPermaTips();
  })

  EventBus.on(EVENT.paletteLockChanged, (active)=>{
    permaTips.paletteLock = active;
    setPermaTips();
  })

  EventBus.on(COMMAND.RECORDINGSTART, ()=>{
    permaTips.recording = true;
    setPermaTips();
  })

  EventBus.on(COMMAND.RECORDINGSTOP, ()=>{
    permaTips.recording = false;
    setPermaTips();
  })

  function setPermaTips(){
    permaTip.innerHTML = "";
    if (permaTips.pen) permaTip.innerHTML += "Pen mode ";
    if (permaTips.paletteLock) permaTip.innerHTML += "Palette lock ";
    if (permaTips.recording) permaTip.innerHTML += "● Recording ";
    permaTip.classList.toggle("active",!!permaTip.innerHTML);
  }

  return me;
})();

export default StatusBar;