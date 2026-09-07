let EventBus = function(){
    let me = {};
    let handlers = {};
    let active = true;
    let buffer = {};

    me.hold = function(){
        active = false;
    }
    me.release = function(){
        // Reopen the bus and take the buffer BEFORE replaying: me.trigger() re-buffers while
        // `active` is false, so replaying first and clearing afterwards threw every held event
        // away instead of delivering it. That is how opening an animation ended up with all
        // its frames in the document but only the first one drawn in the timeline.
        let held = buffer;
        buffer = {};
        active = true;
        let keys = Object.keys(held);
        console.log("releasing " + keys.length + " event(s)")
        keys.forEach(key=>{
            me.trigger(key,held[key]);
        });
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