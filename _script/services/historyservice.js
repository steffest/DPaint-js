import EventBus from "../util/eventbus.js";
import {COMMAND} from "../enum.js";

let HistoryService = function(){
    let me = {};

    let maxHistory = 20;

    let currentHistory = [];
    let history = [];
    let future = [];

    me.start = function(data){
        currentHistory = [data];
        future = [];
    }

    me.end = function(){
        if (currentHistory.length>1){
            history.unshift(currentHistory);
            if (history.length>maxHistory) history.pop();
        }
        currentHistory = [];
    }

    me.log = function(step){
        currentHistory.unshift(step);
    }
    
    me.clear = function(){
        history = [];
        future = [];
    }

    EventBus.on(COMMAND.UNDO,()=>{
        if (history.length){
            currentHistory = history.shift();

            let data = currentHistory.pop();
            let command = data[0];
            if (command === COMMAND.DRAW){
                let ctx = data[1];
                let onChange = data[2];

                currentHistory.forEach(step=>{
                    let x = step[0];
                    let y = step[1];
                    ctx.putImageData(step[2],x,y)
                });

                if (onChange) onChange();
            }
            currentHistory.push(data);
            future.unshift(currentHistory);
        }
    })

    EventBus.on(COMMAND.REDO,()=>{
        if (future.length){
            currentHistory = future.shift();

            let data = currentHistory.pop();
            let command = data[0];
            if (command === COMMAND.DRAW){
                let ctx = data[1];
                let onChange = data[2];

                currentHistory.forEach(step=>{
                    let x = step[0];
                    let y = step[1];
                    ctx.putImageData(step[3],x,y)
                });

                if (onChange) onChange();
            }

            currentHistory.push(data);
            history.unshift(currentHistory);
        }
    })

    
    return me;
}()

export default HistoryService;