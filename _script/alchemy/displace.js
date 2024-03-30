let process = function(source,target){
    let expose = {
        colsWidth:{min:0,max:32,value:0},
        rowWidth:{min:0,max:32,value:2},
        horizontalShift:{min:-10,max:10,value:-1},
        verticalShift:{min:-10,max:10,value:0},
        rippleSpeed:{min:0,max:100,value:0},
        rippleSize:{min:-50,max:50,value:0},

    };

    let w = source.width;
    let h = source.height;
    target.clearRect(0,0,target.canvas.width,target.canvas.height);

    if (expose.colsWidth.value){
        let cols = Math.ceil(w/expose.colsWidth.value);
        for (let i=0;i<cols;i++){
            let x = i*expose.colsWidth.value;
            let y = 0;
            let x2 = x+(expose.horizontalShift.value*i);
            let y2 = y+(expose.verticalShift.value*i);

            if (expose.rippleSpeed.value && expose.rippleSize.value){
                let speed = 100-expose.rippleSpeed.value;
                y2 += Math.round(Math.sin(i/speed)*expose.rippleSize.value);
            }

            target.drawImage(source,x,y,expose.colsWidth.value,h,x2,y2,expose.colsWidth.value,h);
        }
    }

    if (expose.rowWidth.value){
        let rows = Math.ceil(h/expose.rowWidth.value);
        for (let i=0;i<rows;i++){
            let x = 0;
            let y = i*expose.rowWidth.value;
            let x2 = x+(expose.horizontalShift.value*i);
            let y2 = y+(expose.verticalShift.value*i);

            if (expose.rippleSpeed.value && expose.rippleSize.value){
                let speed = 100-expose.rippleSpeed.value;
                x2 += Math.round(Math.sin(i/speed)*expose.rippleSize.value);
            }


            target.drawImage(source,x,y,w,expose.rowWidth.value,x2,y2,w,expose.rowWidth.value);
        }
    }



}



export default process;