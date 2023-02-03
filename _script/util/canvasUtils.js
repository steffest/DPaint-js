
export function duplicateCanvas(canvas){
    let result = document.createElement("canvas");
    result.width = canvas.width;
    result.height = canvas.height;
    result.getContext("2d").drawImage(canvas,0,0);
    return result;
}

export function releaseCanvas(canvas) {
    // mostly needed for safari as it tends to hold on the canvas elements;
    canvas.width = 1;
    canvas.height = 1;
    canvas.getContext('2d').clearRect(0, 0, 1, 1);
}

