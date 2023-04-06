import Adf from "../../fileformats/adf.js";
import $ from "../../util/dom.js";
import ImageFile from "../../image.js";
import Modal,{DIALOG} from "../modal.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND} from "../../enum.js";
import BinaryStream from "../../util/binarystream.js";
import IFF from "../../fileformats/iff.js";
import SaveDialog from "./saveDialog.js";
import Generate from "../../fileformats/generate.js";

let FileBrowser = function(){
    let me = {};
    let container;
    let listContainer;
    let diskInfo;
    let currentFile;

    me.show = function(){
        document.body.classList.add("withfilebrowser");
        if (container) container.classList.add("active");
    }

    me.hide = function(){
        document.body.classList.remove("withfilebrowser");
        if (container) container.classList.remove("active");
    }

    me.openAdf = (files)=>{
        if (files){
            var file = files[0];
            var reader = new FileReader();
            reader.onload = function(){
                Adf.loadDisk(reader.result,result=>{
                    if (result){
                        diskInfo = Adf.getInfo();
                        if (!container) generate();
                        me.show();
                        let root = Adf.readRootFolder();
                        listFolder(root);
                    }else{
                        Modal.alert("Sorry, this doesn't seem to be an ADF file.","Error reading disk file");
                    }
                });

            }
            reader.readAsArrayBuffer(file);
        }
    }

    function generate(){
        let parent = document.querySelector(".container");
        container = $(".filebrowser",
            {parent:parent},
            $(".caption","File Browser",$(".close",{
                onclick:()=>{
                    me.hide();
                },info:"Close File Browser"},"x")),
            listContainer = $(".list")
        );
    }

    function listFolder(root){
        listContainer.innerHTML = "";

        listContainer.appendChild($(".disk",diskInfo.label || "Disk",$(".download",{
            onclick:()=>{
                EventBus.trigger(COMMAND.SAVEDISK,[Adf.getDisk().buffer,diskInfo.label || "Disk.adf"])
            },
            info:"Download disk as ADF file"
        })));

        if (root.sector !== 880){
            $(".listitem.folder",
                {
                    parent:listContainer,
                    onclick:()=>{listFolder(Adf.readFolderAtSector(root.parent))}
                }, "..."
            );
        }

        root.folders.forEach(folder=>{
            $(".listitem.folder",{
                    parent:listContainer,
                    onclick:()=>{
                        let _folder = Adf.readFolderAtSector(folder.sector)
                        listFolder(_folder);
                    }},
                folder.name
            );
        });

        root.files.forEach(file=>{
            let ext = file.name.split(".").pop();
            let isImage = ext==="info" || ext==="iff" || ext==="ilbm" || ext==="pic" || ext==="png" || ext==="jpg" || ext==="jpeg" || ext==="gif";
            if (!isImage){
                let f = Adf.readFileAtSector(file.sector,true);
                let bs = new BinaryStream(f.content.buffer,true);
                let id = bs.readWord(0);
                if (id === 0xE310) isImage = true; // icon
                isImage = isImage || IFF.detect(bs);
            }
            $(".listitem.file" + (isImage ? ".image" : ""),{
                    parent:listContainer,
                    onclick:()=>{
                        if (isImage){
                            openFile(file);
                        }else{
                            Modal.show(DIALOG.OPTION,{
                                title: "File Browser",
                                text: "This file is not an image file. Do you want to download it?",
                                buttons: [
                                    {label:"Yes",onclick:()=>{EventBus.trigger(COMMAND.SAVEGENERIC,[Adf.readFileAtSector(file.sector,true).content.buffer,file.name])}},
                                    {label:"No"}
                                ]
                            })
                        }
                    }
                },
                file.name
            );
        });
    }

    function openFile(file){
        currentFile = file;
        let f = Adf.readFileAtSector(file.sector,true);
        ImageFile.handleBinary(f.content.buffer,file.name,"file",true);
        SaveDialog.setFile(file);
    }

    EventBus.on(COMMAND.SAVEFILETOADF,([currentFile,name])=>{
        let currentSector = currentFile.sector;
        if (currentSector){
            let f = Adf.readFileAtSector(currentSector);
            if (f && f.name === currentFile.name){
                let ext = currentFile.name.split(".").pop();
                let newExt = name.split(".").pop();
                if (ext !== newExt) name += "." + ext;
                let f = ImageFile.getCurrentFile();
                let type = f.originalType || "colorIcon";
                Generate.file(type).then(data=>{
                    if (data){
                        console.log("save file to adf",currentFile,name);
                        Adf.deleteFileAtSector(currentSector);
                        let sector = Adf.writeFile(name,data,currentFile.parent);

                        // update current file in dpaint.js
                        let f = Adf.readFileAtSector(sector,false);
                        currentFile=f;
                        SaveDialog.setFile(f);
                        Modal.hide();
                    }
                });
            }else{
                Modal.alert("Sorry, this doesn't seem to be the ADF disk this file was opened from.","Error saving file");
            }
        }
    });


    return me;
}

export default FileBrowser();