import Canvas from "./canvas.js";
import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import EditPanel from "./editpanel.js";
import ImageProcessing from "../util/imageProcessing.js";
import ImageFile from "../image.js";
import Selection from "./selection.js";
import Palette from "./palette.js";

var Editor = function(){
    var me = {};
    let panels=[];
    let divider;
    var container;
    var zoomFactor = 1.1;
    var activePanel;
    var currentTool = COMMAND.DRAW;
    var touchData = {};
    var state= {
        splitPanel: false
    }

    me.init=function(parent){
        container = $div("editor splitpanel","",parent);
        panels.push(EditPanel(container,"left"));
        divider = $div("splitter","",container,(e)=>{
            touchData.totalWidth = container.getBoundingClientRect().width;
            touchData.startWith = panels[0].getWidth();
            touchData.startWith2 = panels[1].getWidth();
            touchData.startX = parseInt(divider.style.marginLeft) || -3;
        })
        panels.push(EditPanel(container,"right"));
        activePanel = panels[0];

        divider.onDrag = function(x,y){
            console.error(x,y);
            let w = touchData.startWith+x;
            let w2 = touchData.startWith2-x;
            let min = 120;

            if (w<min) x = min-touchData.startWith;
            if (w2<min) x = touchData.startWith2-min;

            w = (touchData.startWith+x)*100/touchData.totalWidth;
            divider.style.left = w + "%";
            panels[0].setWidth(w,true);
            w = (touchData.startWith2-x)*100/touchData.totalWidth;
            panels[1].setWidth(w,true);
        }
        
        EventBus.on(COMMAND.ZOOMIN,function(center){
            activePanel.zoom(zoomFactor,center);
        });
        EventBus.on(COMMAND.ZOOMOUT,function(center){
            activePanel.zoom(1/zoomFactor,center);
        });
        EventBus.on(COMMAND.DRAW,function(){
            currentTool = COMMAND.DRAW;
            document.body.classList.remove("select");
            document.body.classList.add("draw");
        });
        EventBus.on(COMMAND.ERASE,function(){
            currentTool = COMMAND.ERASE;
            document.body.classList.remove("select");
            document.body.classList.add("draw");
        });
        EventBus.on(COMMAND.SELECT,function(){
            currentTool = COMMAND.SELECT;
            document.body.classList.add("select");
            document.body.classList.remove("draw");
        });
        EventBus.on(COMMAND.SQUARE,function(){
            currentTool = COMMAND.SQUARE;
            document.body.classList.add("select");
            document.body.classList.remove("draw");
        });
        EventBus.on(COMMAND.SPLITSCREEN,function(){
            me.splitPanel();
        });
        EventBus.on(COMMAND.ROTATE,function(){
            EventBus.trigger(COMMAND.CLEARSELECTION);
            ImageProcessing.rotate(ImageFile.getCanvas());
            EventBus.trigger(EVENT.imageSizeChanged);
        });
        EventBus.on(COMMAND.CLEAR,function(){
            var s = Selection.get();
            if (s){
                let ctx = ImageFile.getActiveContext();
                if (ctx) ctx.fillStyle = Palette.getBackgroundColor();
                ctx.fillRect(s.x,s.y,s.width,s.height);
                EventBus.trigger(EVENT.imageContentChanged);
            }
        });
        EventBus.on(COMMAND.CROP,function(){
            var s = Selection.get();
            if (s){
                let c = ImageFile.getCanvas();
                let ctx = c.getContext("2d");
                let canvas = document.createElement("canvas");
                canvas.width = s.width;
                canvas.height = s.height;

                canvas.getContext("2d").fillStyle = "blue";
                canvas.getContext("2d").fillRect(0,0,s.width,s.height);
                canvas.getContext("2d").drawImage(c,s.left,s.top,s.width,s.height,0,0,s.width,s.height);
                c.width = s.width;
                c.height = s.height;
                ctx.clearRect(0,0,s.width,s.height);
                ctx.drawImage(canvas,0,0);
                Selection.move(0,0,s.width,s.height);
                EventBus.trigger(EVENT.imageSizeChanged);

            }
        });

    }

    me.set = function(image){
        //panels.forEach(panel=>panel.set(image,true));
    }

    me.setPanel = function(image,index){
        //panels[index].set(image,false);
    }

    me.setActivePanel = function(panel){
        activePanel = panels[panel];
    }

    me.getActivePanel = function(){
        return activePanel;
    }

    me.getCurrentTool = function(){
        return currentTool;
    }

    me.splitPanel = function(){
        state.splitPanel = !state.splitPanel;
        if (divider.style.display === "block"){
            panels[0].setWidth(100,true);
            panels[1].hide();
            divider.style.display = "none";
        }else{
            panels[0].setWidth("calc(50% - 4px)");
            panels[1].setWidth("calc(50% - 4px)");
            panels[1].show();
            divider.style.display = "block";
            EventBus.trigger(EVENT.imageSizeChanged);
        }
    }

    me.isStateActive = function(name){
        return !!state[name];
    }


    return me;
}();

export default Editor;