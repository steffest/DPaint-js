import BinaryStream from "../util/binarystream.js";
import AmigaIcon from "./amigaIcon.js";
import IFF from "./iff.js";

let FileDetector = function(){
    let me = {};

    me.detect = function(data,name){
        return new Promise(next=>{
            name = name || "";
            let file = BinaryStream(data.slice(0,data.byteLength),true);
            file.goto(0);
            let detected = false;

            if (name.indexOf(".info")>0){
                // Note: this can be Async!
                AmigaIcon.parse(file,function(icon){
                    if (icon){
                        console.log("Amiga Icon");
                        console.log(icon);
                        let canvas = AmigaIcon.getImage(icon);
                        let canvas2 = AmigaIcon.getImage(icon,1);
                        next({image:[canvas,canvas2],type:AmigaIcon.getType(icon)});
                    }else{
                        detectIFF();
                    }
                });
            }else{
                detectIFF();
            }

            function detectIFF(){
                let result = IFF.detect(file);
                if (result){
                    let data = IFF.parse(file,true);
                    if (data && data.width){
                        next({image:IFF.toCanvas(data),type:"IFF"});
                    }else{
                        next(false);
                    }
                }else{
                    next(false);
                }
            }
        });
    }
    return me;
}();

export default FileDetector;
