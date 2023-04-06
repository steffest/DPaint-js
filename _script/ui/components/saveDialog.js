import $ from "../../util/dom.js";
import ImageFile from "../../image.js";
import saveAs from "../../util/filesaver.js";
import Modal, {DIALOG} from "../modal.js";
import Palette from "../palette.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import Generate from "../../fileformats/generate.js";

var SaveDialog = function(){
    let me ={};
    let nameInput;
    let currentFile;

    let filetypes = {
        IFF:{
            description: 'IFF ILMB Image',
            accept: {
                'image/x-ilbm': ['.iff'],
            }
        },
        PNG:{
            description: 'PNG Image',
            accept: {
                'image/png': ['.png'],
            }
        },
        ICO:{
            description: 'Amiga Icon',
            accept: {
                'application/octet-stream': ['.info'],
            }
        },
        PALETTE:{
            description: 'DPaint.js Palette',
            accept: {
                'application/json': ['.json'],
            }
        },
        DPAINTJS:{
            description: 'DPaint.js File',
            accept: {
                'application/json': ['.json'],
            }
        },
        ADF:{
            description: 'Amiga Disk File',
            accept: {
                'application/octet-stream': ['.adf'],
            }
        },
        FILE:{
            description: 'File'
        },
    }

    async function saveFile(blob,fileName,type) {
        if (window.showSaveFilePicker){
            const newHandle = await window.showSaveFilePicker({
                suggestedName: fileName,
                types: [type],
            });
            const writableStream = await newHandle.createWritable();
            await writableStream.write(blob);
            await writableStream.close();
        }else{
            await saveAs(blob,fileName);
        }
    }

    me.render = function(container){
        container.innerHTML = "";
        container.appendChild(
            $(".saveform",
                $(".name",$("h4","Name"),nameInput = $("input",{type:"text",value:ImageFile.getName()})),
                $("h4","Save as"),
                $(".platform.general",
                    $("h4.general","General"),
                    renderButton("png","PNG Image","PNG file","Full color and transparency, no layers, only the current frame gets saved.",writePNG),
                    renderButton("json","DPaint.JSON","JSON file","The internal format of Dpaint.js",writeJSON),
                    renderButton("psd","PSD","Coming soon ...","Working on it!")
                ),
                $(".platform.amiga",
                    $("h4.amiga","Amiga"),
                    currentFile ? renderButton("adf","ADF","Save to ADF","Save Back to ADF. (Download the ADF afterwards when you're done editing)",writeADF) : null,
                    renderButton("iff","IFF Image","Amiga IFF file","Maximum 32 colours, only the current frame gets saved.",writeIFF),
                    renderButton("mui","Amiga Classic Icon","OS1.3 Style","For all Amiga's. Use MUI palette for best compatibility",writeAmigaClassicIcon),
                    renderButton("os3","Amiga Color Icon","OS3.2 Style","Also called 'Glowicons'. For modern Amiga systems and/or with PeterK's Icon Library. Max 256 colors.",writeAmigaColorIcon),
                    renderButton("os4","Amiga Dual PNG Icon","OS4 Style","For modern Amiga systems and/or with PeterK's Icon Library. Full colors.",writeAmigaPNGIcon)
                )
        ));

        nameInput.onkeydown = function(e){
            e.stopPropagation();
        }
        nameInput.onchange = function(){
            ImageFile.setName(getFileName());
        }
    }

    me.setFile = function (file){
        currentFile = file;
    }

    function renderButton(type,title,subtitle,info,onClick){
        return $(".button",{onclick:onClick},
            $(".icon."+type),
            $(".title",title),
            $(".subtitle",subtitle),
            $(".info",info)
        );
    }

    function getFileName(){
        let name = nameInput ? nameInput.value.replace(/[ &\/\\#,+()$~%.'":*?<>{}]/g, ""):"";
        return name || "Untitled"
    }

    async function writeIFF(){
        let blob = await Generate.file("IFF");
        if (blob){
            let fileName = getFileName() + '.iff';
            await saveFile(blob,fileName,filetypes.IFF);
            Modal.hide();
        }
    }

    function writeADF(){
        EventBus.trigger(COMMAND.SAVEFILETOADF,[currentFile,getFileName()]);
    }

    async function writePNG(){
        let blob = await Generate.file("PNG");
        if (blob){
            await saveFile(blob,getFileName() + ".png",filetypes.PNG);
            Modal.hide();
        }
    }

    async function writeJSON(){
        let blob = await Generate.file("DPAINT");
        if (blob){
            await saveFile(blob,getFileName() + '.json',filetypes.DPAINTJS);
            Modal.hide();
        }
    }

    async function writeAmigaClassicIcon(config){
        let blob = await Generate.file("classicIcon");
        if (blob){
            await saveFile(blob,getFileName() + '.info',filetypes.ICO);
            Modal.hide();
        }
    }

    async function writeAmigaPNGIcon(){
        let blob = await Generate.file("PNGIcon");
        if (blob){
            saveFile(blob, getFileName() + '.info',filetypes.ICO).then(()=>{
                Modal.hide();
            });
        }
    }

    async function writeAmigaColorIcon(){
        let blob = await Generate.file("colorIcon");
        if (blob){
            await saveFile(blob,getFileName() + '.info',filetypes.ICO);
            Modal.hide();
        }
    }

    EventBus.on(COMMAND.SAVEPALETTE,()=>{
        let struct = {
            type: "palette",
            palette:  Palette.get()
        }
        let blob = new Blob([JSON.stringify(struct,null,2)], { type: 'application/json' })
        saveFile(blob,getFileName() + '_palette.json',filetypes.PALETTE).then(()=>{

        });
    });

    EventBus.on(COMMAND.SAVEDISK,([data,fileName])=>{
        let blob = new Blob([data], {type: "application/octet-stream"})
        saveFile(blob,fileName,filetypes.ADF).then(()=>{});
    })

    EventBus.on(COMMAND.SAVEGENERIC,([data,fileName])=>{
        let blob = new Blob([data], {type: "application/octet-stream"})
        saveFile(blob,fileName,filetypes.FILE).then(()=>{});
    })


    return me;
}();

export default SaveDialog;