let EventBus = function(){
    let me = {};
    let handlers = {};
    let active = true;
    let buffer = {};

    me.hold = function(){
        active = false;
    }
    me.release = function(){
        let keys = Object.keys(buffer);
        console.log("releasing " + keys.length + " event(s)")
        keys.forEach(key=>{
            me.trigger(key,buffer[key]);
        });
        buffer = {};
        active = true;
    }

    me.trigger = function(action,context){
        if (!active){
            buffer[action] = context;
            return;
        }
        let actionHandler = handlers[action];
        if (actionHandler){
            actionHandler.forEach(handler=>{
                handler(context);
            })
        }
    }

    me.on = function(action,handler){
        handlers[action] = handlers[action] || [];
        let actionHandler = handlers[action];
        actionHandler.push(handler);
    }

    return me;
}();

export default EventBus;