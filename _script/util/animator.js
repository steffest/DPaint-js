let Animator = function(){
    let me = {};
    let running = false;
    let tickFunctions = []


    me.start = function(tickFunction,fps){
        let tick = {
            tickFunction: tickFunction,
            fps: fps,
            fpsInterval: 1000 / fps,
            then: window.performance.now(),
            startTime: window.performance.now(),
        }
        tickFunctions.push(tick);
        if (!running){
            running = true;
            requestAnimationFrame(animate);
        }
    }

    me.stop = function(){
        running = false;
        tickFunctions = [];
    }

    me.isRunning = function(){
        return running;
    }

    function animate(newtime) {
        if (!running) return;
        requestAnimationFrame(animate);

        tickFunctions.forEach(tick=>{
            tick.now = newtime;
            tick.elapsed = tick.now - tick.then;

            if (tick.elapsed > tick.fpsInterval) {
                tick.then = tick.now - (tick.elapsed % tick.fpsInterval);
                tick.tickFunction();
            }
        })
    }

    return me;
}();

export default Animator;