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
            if (parts.length===4) return [parseInt(parts[0]),parseInt(parts[1]),parseInt(parts[2]),parseInt(parts[3])];
            return [parseInt(parts[0]),parseInt(parts[1]),parseInt(parts[2])];
        }
        if (color.indexOf("#") === 0){
            let r = parseInt(color.substr(1,2),16);
            let g = parseInt(color.substr(3,2),16);
            let b = parseInt(color.substr(5,2),16);
            if (color.length===9) return [r,g,b,parseInt(color.substr(7,2),16)];
            return [r,g,b];
        }
        return color;
    }

    me.toHex=function(color){
        if (typeof color==="string"){
            color = me.fromString(color);
        }
        if (typeof color === "object" && color.length){
            let result = "#" + hexByte(color[0]) + hexByte(color[1]) +  hexByte(color[2]);
            if (color.length===4) result += hexByte(color[3]);
            return result;
        }
    }

    me.distance = function(color1,color2){
        color1 = me.fromString(color1);
        color2 = me.fromString(color2);
        let r = color1[0] - color2[0];
        let g = color1[1] - color2[1];
        let b = color1[2] - color2[2];
        if (color1.length===4 && color2.length===4){
            let a = color1[3] - color2[3];
            return Math.sqrt(r*r + g*g + b*b + a*a);
        }
        return Math.sqrt(r*r + g*g + b*b);
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