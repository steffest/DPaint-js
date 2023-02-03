var Color = function(){
    var me = {};

    me.toString = function(color){
        // Uint8ClampedArray returns false on isArray;
        if (typeof color === "object" && color.length){
            return "rgb(" + color[0] + "," + color[1] + "," +  color[2] + ")";
         }
        return color;
    }

    me.fromString = function(color){
        if (typeof color === "object") return color;
        if (color.indexOf("rgb") === 0){
            let parts = color.split("(")[1].split(")")[0].split(",");
            return [parseInt(parts[0]),parseInt(parts[1]),parseInt(parts[2])];
        }
        if (color.indexOf("#") === 0){
            let r = parseInt(color.substr(1,2),16);
            let g = parseInt(color.substr(3,2),16);
            let b = parseInt(color.substr(5,2),16);
            return [r,g,b];
        }
        return color;
    }

    me.toHex=function(color){
        if (typeof color==="string"){
            color = me.fromString(color);
        }
        if (typeof color === "object" && color.length){
            return "#" + hexByte(color[0]) + hexByte(color[1]) +  hexByte(color[2]);
        }
    }

    function hexByte(nr){
        if (typeof nr === "string") nr=parseInt(nr);
        let result = nr.toString(16);
        if (result.length===1) result = "0" + result;
        return result;
    }

    return me;
}();

export default Color;