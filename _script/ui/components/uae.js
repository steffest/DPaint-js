import $ from "../../util/dom.js";
import Adf from "../../fileformats/adf.js";
import Modal from "../modal.js";
import Generate from "../../fileformats/generate.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND} from "../../enum.js";

let UAE = function(){
    let me = {};
    let container;
    let currentTranslate = [0,0];
    let currentSize = [720,588];
    let currentPosition = [(window.innerWidth-currentSize[0])>>1,(window.innerHeight-currentSize[1])>>1];

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
                                    let image = Generate.iff(32,"Sorry, Deluxe Paint II supports a maximum of 32 colors.");
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
            $(".caption.handle",{
                onDragStart:()=>{
                  container.classList.add("dragging");
                },
                onDrag:(x,y)=>{
                    x += currentPosition[0];
                    y += currentPosition[1];
                    currentTranslate = [x,y];
                    container.style.transform = "translate("+x+"px,"+y+"px)";
                },
                onDragEnd:()=>{
                    container.classList.remove("dragging");
                    currentPosition = [currentTranslate[0],currentTranslate[1]];
                }},"Amiga Preview",$(".close",{
                onclick:()=>{
                    me.hide();
                    },info:"Close Amiga Preview"},"x")
            ),$(".resizer.handle",{
                onDragStart:()=>{
                    container.classList.add("dragging");
                },
                onDrag:(x,y)=>{
                    x += currentSize[0];
                    y += currentSize[1];
                    container.style.width = x+"px";
                    container.style.height = y+"px";
                },
                onDragEnd:()=>{
                    container.classList.remove("dragging");
                    currentSize = [container.clientWidth,container.clientHeight];
                }
            }));
        container.style.transform = "translate("+currentPosition[0]+"px,"+currentPosition[1]+"px)";
        container.style.width = currentSize[0]+"px";
        container.style.height = currentSize[1]+"px";
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