import $ from "../../util/dom.js";
import Adf from "../../fileformats/adf.js";
import Modal from "../modal.js";
import Generate from "../../fileformats/generate.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND} from "../../enum.js";

let UAE = function(){
    let me = {};
    let container;

    me.preview = function(){
        window.getUaeContent = function(){
            return new Promise((next)=>{
                fetch("uae/data/boot.adf").then(r=>r.arrayBuffer()).then(buffer=>{
                    Adf.loadDisk(buffer,result=>{
                        if (result){
                            let diskInfo = Adf.getInfo();
                            let root = Adf.readRootFolder();
                            if (root && root.files){
                                let pictureFile = root.files.find(f=>f.name === "picture.iff");
                                if (pictureFile){
                                    let image = Generate.iff();
                                    if (image){
                                        image.arrayBuffer().then(buffer=>{
                                            Adf.deleteFileAtSector(pictureFile.sector);
                                            let sector = Adf.writeFile("picture.iff",buffer,pictureFile.parent);
                                            if (sector){
                                                next(Adf.getDisk().buffer);
                                                //EventBus.trigger(COMMAND.SAVEDISK,[Adf.getDisk().buffer,diskInfo.label || "Disk.adf"])
                                            }
                                        });

                                    }else{
                                        me.hide();
                                    }
                                }
                            }
                        }else{
                            Modal.alert("Sorry, The Amiga Dpaint boot disk is not found","Error reading disk file");
                        }
                    });
                })
            })
        }
        if (container) container.remove();
        container = $(".uae",
            $(".caption","Amiga Preview",$(".close",{
                onclick:()=>{
                    me.hide();
                    },info:"Close Amiga Preview"},"x")
            ));
        let iframe = $("iframe",{
            src:"uae/index.html"
        })
        container.appendChild(iframe);
        document.body.appendChild(container);
    }

    me.hide = function(){
        if (container) container.remove();
    }


    return me;
}();

export default UAE;