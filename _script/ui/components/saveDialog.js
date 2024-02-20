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
            description: 'IFF ILBM Image',
            accept: {
                'image/x-ilbm': ['.iff'],
            }
        },
        PLANES:{
            description: 'Binary Bitplane Data',
            accept: {
                'application/octet-stream': ['.planes'],
            }
        },
        MASK:{
            description: 'Binary Bitplane Mask',
            accept: {
                'application/octet-stream': ['.mask'],
            }
        },
        PNG:{
            description: 'PNG Image',
            accept: {
                'image/png': ['.png'],
            }
        },
        GIF:{
            description: 'GIF Image',
            accept: {
                'image/gif': ['.gif'],
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

     function saveFile(blob,fileName,type) {
        return new Promise(async (resolve,reject)=>{
            if (window.host && window.host.saveFile){
                window.host.saveFile(blob,fileName);
                resolve();
                return;
            }

            if (window.showSaveFilePicker){
                window.showSaveFilePicker({
                    suggestedName: fileName,
                    types: [type],
                }).then(async handle => {
                    const writableStream = await handle.createWritable();
                    await writableStream.write(blob);
                    await writableStream.close();
                    resolve();
                }).catch(async err => {
                    console.error(err);
                    await saveAs(blob,fileName);
                    resolve();
                });
            }else{
                await saveAs(blob,fileName);
                resolve();
            }
        });
    }

    me.render = function(container){
        let submenu;
        container.innerHTML = "";
        let mainPanel;
        container.appendChild(
            $(".saveform",
                $(".name",$("h4","Name"),nameInput = $("input",{type:"text",value:ImageFile.getName()})),
                $("h4","Save as"),
                submenu = $(".moremenu",
                    $(".item",{onClick:writePLANES},"Planes",$(".subtitle","Binary bitplane data")),
                    $(".item",{onClick:writeMASK},"Mask",$(".subtitle","Binary bitplane mask"))
                ),
                $(".platform.general",
                    $("h4.general","General"),
                    renderButton("png","PNG Image","PNG file","Full color and transparency, no layers, only the current frame gets saved.",writePNG),
                    renderButton("json","DPaint.JSON","JSON file","The internal format of Dpaint.js",writeJSON),
                    renderButton("psd","PSD","Coming soon ...","Working on it!"),
                    $(".button.more",{onclick:()=>{
                            submenu.classList.toggle("active");
                            }},"More")
                    //renderButton("planes","BIN","Bitplanes","Binary bitplane data",writePLANES)
                ),
                $(".platform.amiga",
                    $("h4.amiga","Amiga"),
                    currentFile ? renderButton("adf","ADF","Save to ADF","Save Back to ADF. (Download the ADF afterwards when you're done editing)",writeADF) : null,
                    renderButton("iff","IFF Image","Amiga IFF file","Maximum 256 colours, only the current frame gets saved.",writeIFF),
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

        // check if we have a server to post back to
        let postBack;
        let urlParams = new URLSearchParams(window.location.search);
        let url;
        if (urlParams.has("putback")){
            url = urlParams.get("putback");
            if (url) postBack = {method: "PUT", url: url}
        }
        if (urlParams.has("postback")){
            url = urlParams.get("postback");
            if (url) postBack = {method: "POST", url: url}
        }

        if (postBack){
            try {
                let url = new URL(postBack.url,window.location.href);
                postBack.domain = url.hostname;
                postBack.url = postBack.url = url.href;
            }catch{
                postBack = undefined;
            }
        }
        if (postBack) addPostBackOverlay(postBack,container);
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

    function addPostBackOverlay(postBack,container){
        let overridePanel = $(".saveoverlay",

            $(".info","This editor is configured to save files back to",$("b",postBack.domain), $(".textlink",{onClick:()=>{overridePanel.remove()}},"More options")),
            $(".spinner"),
            $(".buttons",
                $(".button.ghost",{onclick:()=>{
                    Modal.hide();
                }},"Cancel"),
                $(".button.primary",{onclick:async ()=>{
                    overridePanel.classList.add("loading");
                    let blob = await Generate.file("PNG");
                    if (blob){
                        fetch(postBack.url,{
                            method: postBack.method,
                            body: blob
                        }).then((response)=>{
                            if (response.ok){
                                Modal.hide();
                            }else{
                                Modal.alert("Error saving file to server");
                            }
                        }).catch((err)=>{
                            Modal.alert("Error saving file to server");
                        });
                    }
                }},"Save")
            )
        );

        container.appendChild(overridePanel);
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

    async function writePLANES(){
        let result = await Generate.file("BitPlanes");
        console.error(result);
        if (result && result.planes){
            let blob = new Blob([result.planes], {type: "application/octet-stream"});
            let fileName = getFileName() + '.planes';
            await saveFile(blob,fileName,filetypes.PLANES);

            fileName = getFileName() + '.palette.txt';
            let content = "{";
            for (let i=0;i<result.palette.length;i++){
                let color = result.palette[i];
                content += "0X";
                color.forEach(c=>{
                    c = Math.round(c/16);
                    if (c>15) c=15;
                    content += c.toString(16);
                })
                content += ",";
            }
            content = content.slice(0,-1) + "}";
            let blob2 = new Blob([content], {type: "application/octet-stream"});
            await saveFile(blob2,fileName,filetypes.FILE);
            Modal.hide();
        }
    }

    async function writeMASK(){
        let result = await Generate.file("BitMask");
        console.error(result);
        if (result && result.planes){
            let blob = new Blob([result.planes], {type: "application/octet-stream"});
            let fileName = getFileName() + '.mask';
            await saveFile(blob,fileName,filetypes.MASK);
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

    window.png8 = function(){
        Generate.file("PNG8").then((blob)=>{
            if (blob){
                saveFile(blob,getFileName() + ".png",filetypes.PNG).then(()=>{});
            }
        });
    }

    window.savegif = function(){
        Generate.file("GIF").then((blob)=>{
            if (blob){
                saveFile(blob,getFileName() + ".gif",filetypes.GIF).then(()=>{});
            }
        });
    }


    return me;
}();

export default SaveDialog;