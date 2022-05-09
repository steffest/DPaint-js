import BinaryStream from "../util/binarystream.js";
import AmigaIcon from "./amigaIcon.js";
import IFF from "./iff.js";

let FileDetector = function(){
    let me = {};

    me.detect = function(fileObject,data){
        return new Promise(next=>{
            let name = fileObject.name || "";
            let file = BinaryStream(data.slice(0,data.byteLength),true);
            file.goto(0);

            if (name.indexOf(".info")>0){
                AmigaIcon.parse(file,function(icon){
                    if (icon){
                        console.log("Amiga Icon");
                        console.log(icon);
                        let canvas = AmigaIcon.getImage(icon);
                        let canvas2 = AmigaIcon.getImage(icon,1);
                        next([canvas,canvas2]);
                    }
                });
            }

            let result = IFF.detect(file);
            console.error(result);
            if (result){
                let data = IFF.parse(file,true);
                if (data && data.width){
                    next(IFF.toCanvas(data));
                }

            }
        });
    }
    return me;
}();

export default FileDetector;
