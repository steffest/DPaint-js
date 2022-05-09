let EventBus = function(){
    let me = {};
    let handlers = {};

    me.trigger = function(action,context){
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