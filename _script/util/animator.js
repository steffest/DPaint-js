let Animator = function(){
    let me = {};
    let running = {};
    let tickFunctions = {};
    let needsTicking = false;


    me.start = function(type,tickFunction,fps){
        tickFunctions[type] = tickFunctions[type] || [];
        let tick = {
            tickFunction: tickFunction,
            fps: fps,
            fpsInterval: 1000 / fps,
            then: window.performance.now(),
            startTime: window.performance.now(),
        }
        tickFunctions[type].push(tick);
        if (!running[type]){
            let wasTicking = isTicking();
            running[type] = true;
            needsTicking = true;
            if (!wasTicking) requestAnimationFrame(animate);
        }
    }

    me.stop = function(type){
        running[type] = false;
        tickFunctions[type] = [];
        needsTicking = isTicking();
    }

    me.isRunning = function(type){
        return running[type];
    }

    function animate(newtime) {
        if (!needsTicking) return;
        requestAnimationFrame(animate);

        for (let key in running){
            if (running[key]){
                let functions = tickFunctions[key];
                functions.forEach(tick=>{
                    tick.now = newtime;
                    tick.elapsed = tick.now - tick.then;

                    if (tick.elapsed > tick.fpsInterval) {
                        tick.then = tick.now - (tick.elapsed % tick.fpsInterval);
                        tick.tickFunction();
                    }
                })
            }
        }
    }

    function isTicking(){
        for (let key in running){
            if (running[key]) return true;
        }
        return false;
    }

    return me;
}();

export default Animator;