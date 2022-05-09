var Color = function(){
    var me = {};

    me.toString = function(color){
        // Uint8ClampedArray returns false on isArray;
        if (typeof color === "object" && color.length){
            return "rgb(" + color[0] + "," + color[1] + "," +  color[2] + ")";
         }
        return color;
    }

    return me;
}();

export default Color;