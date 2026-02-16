import $, {$input} from "../../util/dom.js";
import ImageFile from "../../image.js";
import saveAs from "../../util/filesaver.js";
import Modal, {DIALOG} from "../modal.js";
import Palette from "../palette.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import Generate from "../../fileformats/generate.js";
import Brush from "../brush.js";
import Color from "../../util/color.js";
import BinaryStream from "../../util/binarystream.js";
import ImageProcessing from "../../util/imageProcessing.js";

var SaveDialog = function(){
    let me ={};
    let nameInput;
    let currentFile;
    let container;
    let mainPanel;
    let imageinfo;
    let currentSaveOptions = {
        type:"PNG",
        quality: 90,
        depth: 24,
        palette: "optimized",
        iconType: "colorIcon",
        compression: true  // Default to compressed for ANIM files
    };
    let UIelm = {};


    let filetypes = {
        IFF:{
            description: 'IFF ILBM Image',
            extension: "iff",
            generator: "IFF",
            accept: {
                'image/x-ilbm': ['.iff'],
            }
        },
        ANIM:{
            description: 'IFF Animation',
            extension: "anim",
            generator: "ANIM",
            accept: {
                'image/x-ilbm': ['.anim'],
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
        SPRITE:{
            description: 'Sprite C Source',
            extension: "c",
            generator: "SPRITE",
            accept: {
                'application/octet-stream': ['.c'],
            }
        },
        PNG:{
            description: 'PNG Image',
            extension: 'png',
            generator: 'PNG',
            accept: {
                'image/png': ['.png'],
            }
        },
        GIF:{
            description: 'GIF Image',
            generator: "GIF",
            extension: 'gif',
            accept: {
                'image/gif': ['.gif'],
            }
        },
        JPG:{
            description: 'JPG Image',
            generator: "JPG",
            extension: 'jpg',
            accept: {
                'image/jpeg': ['.jpg'],
            }
        },
        ICO:{
            description: 'Amiga Icon',
            extension: 'info',
            accept: {
                'application/octet-stream': ['.info'],
            },
            generator: 'ICO',
        },
        PALETTE:{
            description: 'DPaint.js Palette',
            accept: {
                'application/json': ['.json'],
            }
        },
        DPAINTJS:{
            description: 'DPaint.js File',
            extension: 'json',
            generator: 'DPAINT',
            accept: {
                'application/json': ['.json'],
            }
        },
        INDEXED:{
            description: 'DPaint.json with indexed color pixels',
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

    me.render = function(_container){
        let menu;
        container = _container;
        container.innerHTML = "";
        container.appendChild(
            mainPanel = $(".saveform",
                $(".flex",
                    $(".panel.main",
                        $(".flex",
                            $(".col.name",$("h4","Name"),nameInput = $("input",{type:"text",value:ImageFile.getName(true)})),
                            $(".col",$("h4","Type"),
                                $(".filetype.inputbox.select",
                                    {onClick:(e)=>{
                                        let button = e.target.closest(".button");
                                        if (button && button.value){
                                            setSaveType(button.value);
                                            menu.classList.remove("active");
                                            return;
                                        }
                                        menu.classList.toggle("active")
                                    }},
                                    menu = $(".menu",
                                        $(".list",
                                            renderButton("json","DPaint.JSON","The internal format of Dpaint. All features supported","DPAINTJS"),
                                            renderButton("png","PNG Image","Full color and transparency, no layers, only the current frame gets saved.","PNG"),
                                            renderButton("gif","GIF Img/anim","Max 256 colors, no layers, animation supported.","GIF"),
                                            renderButton("jpg","JPG Image","Full color, no transparency, no layers, only the current frame gets saved. LOSSY!","JPG"),
                                            renderButton("iff","Amiga IFF","Maximum 256 colors, only the current frame gets saved.","IFF"),
                                            renderButton("anim","Amiga ANIM","Maximum 256 colors, animation supported.","ANIM"),
                                            renderButton("os3","Amiga Icon","Amiga OS Icon, Maximum 2 frames.","ICO"),
                                            renderButton("amiga","Amiga Sprite","C Source.","SPRITE"),

                                            //renderButton("psd","PSD","Coming soon ...","Working on it!"),

                                            //renderButton("planes","BIN","Bitplanes","Binary bitplane data",writePLANES)
                                        )
                                    ),
                                    UIelm.ext = $(".ext"),
                                    UIelm.info = $(".info")
                                )
                            ),
                        ),
                        imageinfo = $(".imageinfo",''),
                        $(".buttons.relative.right",
                            $(".button.cancel.ghost",{onClick:Modal.hide},$("span","Cancel")),
                            $(".button.save.positive",{onClick:saveWithOptions},$("span","Save"))
                        )
                    ),
                    $(".panel.aside",
                        $(".title",{onClick:toggleOptionPanel},"Options"),
                        $(".optionspanel.PNG",
                            $(".content",
                                $('.group.inline',
                                    $("label","Colors"),
                                    $(".options.inline",
                                        {key:"depth"},
                                        $(".option.selected",{value:24,onClick:selectOption},"24 Bit",$(".tooltip","Full color, Full alpha")),
                                        $(".option",
                                            {value:8,onClick:selectOption},
                                            "8 Bit",
                                            $(".tooltip","Max 256 colors")
                                        ),
                                    )
                                ),
                                $('.group.pal.hidden',
                                    $("label","Palette"),
                                    $(".options.flex",
                                        {key:"palette"},
                                        $(".option.centered.selected",{value:"optimized",onClick:selectOption},"Optimize",$(".tooltip","Rebuild the palette with used colors")),
                                        $(".option.centered",{value:"locked",onClick:selectOption},"Current",$(".tooltip","Keep existing palette")),
                                    )
                                )
                            )
                        ),
                        $(".optionspanel.GIF",
                            $(".content",
                                ""
                            )
                        ),
                        $(".optionspanel.DPAINTJS",
                            $(".content",
                                $('.group.inline',
                                    $("label","Colors"),
                                    $(".options",
                                        {key:"depth"},
                                        $(".option.selected",{value:24,onClick:selectOption},"24 Bit",$(".tooltip","Full color, Full alpha")),
                                        $(".option",
                                            {value:8,onClick:selectOption},
                                            "8 Bit",
                                            $(".tooltip","Max 256 colors")
                                        ),
                                    )
                                ),
                                $('.group.pal',
                                    $("label","Palette"),
                                    $(".options.flex",
                                        {key:"palette"},
                                        $(".option.suboption.centered.selected",{value:"optimized",onClick:selectOption},"Optimize",$(".tooltip","Rebuild the palette with used colors")),
                                        $(".option.suboption.centered",{value:"locked",onClick:selectOption},"Current",$(".tooltip","Keep existing palette")),
                                    )
                                )
                            )
                        ),
                        $(".optionspanel.JPG",
                            $(".content",
                                $('.group',
                                    $("label","Quality"),
                                    $(".options",
                                        $("input.range",{type:"range",min:1,max:100,value:currentSaveOptions.quality,oninput:(e)=>{
                                            e.target.nextElementSibling.value = e.target.value;
                                            currentSaveOptions.quality = parseInt(e.target.value);
                                            }}),
                                        $("input.rangeinput",{type:"text",value:currentSaveOptions.quality,
                                            onkeydown: (e)=>{
                                                e.stopPropagation();
                                            },
                                            oninput:(e)=>{
                                                e.stopPropagation();
                                                e.preventDefault();
                                                let range = e.target.previousElementSibling;
                                                let v = parseInt(e.target.value);
                                                if (isNaN(v) || v < 1 || v > 100) v = 100;
                                                range.value =v;
                                                currentSaveOptions.quality = v;
                                            }
                                        }),
                                    )
                                )
                            )
                        ),
                        $(".optionspanel.ICO",
                            $(".content",
                                $(".group",
                                    $("label","Icon Format"),
                                    $(".options",   
                                        {key:"iconType"},
                                        $(".option.mui",{value:"classicIcon",onClick:selectOption},"Classic Icon",$(".tooltip.left",$("div","OS1.3 style."),$("div","For all Amiga's."),$("div","Use MUI palette for best compatibility"))),
                                        $(".option.os3.selected",{value:"colorIcon",onClick:selectOption},"Color Icon",$(".tooltip.left",$("div","OS3.2 style."),$("div","Also called 'Glowicons'."),$("div","For modern Amiga systems and/or with PeterK's Icon Library. Max 256 colors."))),
                                        $(".option.os4",{value:"PNGIcon",onClick:selectOption},"PNG Icon",$(".tooltip.left",$("div","OS4 style."),$("div","For modern Amiga systems and/or with PeterK's Icon Library. Full colors.")))
                                    )
                                )
                            )
                        ),
                        $(".optionspanel.IFF",
                            $(".content",
                                $(".group",
                                    $("label","Mode"),
                                    $(".options",
                                        {key:"iffMode"},
                                        $(".option.selected",{value:"standard",onClick:selectOption},"Standard",$(".tooltip.left",$("div","Up to 256 indexed colors."))),
                                        $(".option",{value:"ham6",onClick:selectOption},"HAM6",$(".tooltip.left",$("div","Hold-And-Modify."),$("div","4096 colors (OCS/ECS, 6 planes)."))),
                                        $(".option",{value:"ham8",onClick:selectOption},"HAM8",$(".tooltip.left",$("div","Hold-And-Modify."),$("div","16M colors (AGA only, 8 planes)."))),
                                        $(".option",{value:"sham",onClick:selectOption},"SHAM",$(".tooltip.left",$("div","Sliced HAM."),$("div","Per-scanline palette for best HAM6 quality.")))
                                    )
                                )
                            )
                        ),
                        $(".optionspanel.ANIM",
                            $(".content",
                                $(".group",
                                    $("label","Compression"),
                                    $(".options",   
                                        {key:"compression"},
                                        $(".option",{value:false,onClick:selectOption},"Uncompressed",$(".tooltip.left",$("div","results in larger files, but is faster to read."))),
                                        $(".option.selected",{value:true,onClick:selectOption},"Compressed",$(".tooltip.left",$("div","Uses ByteRun1 compression for the bitplane data.")))
                                    )
                                )
                            )
                        ),
                    ),
                )
        ));

        nameInput.onkeydown = function(e){
            e.stopPropagation();
        }
        nameInput.onchange = function(){
            ImageFile.setName(getFileName());
        }

        setSaveType(currentSaveOptions.type || "PNG");


        let  file = ImageFile.getCurrentFile();
        let infoText = [];
        console.error(file);
        if (file.width && file.height){
            infoText.push(file.width + " x " + file.height + " px");
        }
        let colorCount = ImageProcessing.getColors(ImageFile.getCanvasWithFilters()).length;
        infoText.push(colorCount + " colors");
        imageinfo.innerHTML = infoText.join(" - ");

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

    function toggleOptionPanel(e){
        let panel = e.target.closest(".optionspanel");
        if (!panel) return;
        panel.classList.toggle("active");
        currentSaveOptions.showOptions = panel.classList.contains("active");
    }

    function selectOption(e){
        let parent = e.target.closest(".options");
        let option = e.target.closest(".option");
        if (!option || !parent) return;
        let isSub = option.classList.contains("suboption");

        let options = parent.querySelectorAll(".option");
        options.forEach(elm=>{
            if (!isSub && elm.classList.contains("suboption")) return;
            elm.classList.remove("selected");
        })
        option.classList.add("selected");

        if (parent.key && (option.value || option.value === false)){
            currentSaveOptions[parent.key] = option.value;
        }

        if (parent.key === "depth"){
            let panel = parent.closest(".optionspanel");
            let paletteOption = panel.querySelector(".group.pal");
            if(paletteOption){
                paletteOption.classList.toggle("disabled",option.value===24);
            }
        }
    }

    function saveWithOptions(e){
        let button = e.target.closest(".button");
        waitFor(writeFile(),button);
    }

    function setSaveType(type){
        let fileType = filetypes[type];
        if (!fileType) {
            console.error("Unknown file type",type);
            return;
        }
        currentSaveOptions.type = type;
        currentSaveOptions.fileType = fileType;

        // Set UI elements
        UIelm.ext.innerHTML = "." + fileType.extension;
        UIelm.ext.className = "ext " + fileType.extension;
        UIelm.info.innerHTML = fileType.description || "";

        let optionsPanel = mainPanel.querySelector(".optionspanel." + type);
        let active = mainPanel.querySelectorAll(".optionspanel.visible");
        active.forEach(item => {
            item.classList.remove("visible");
        })
        if (optionsPanel){
            optionsPanel.classList.add("visible");
            optionsPanel.classList.toggle("active",!!currentSaveOptions.showOptions);

            // set options state
            let options = optionsPanel.querySelectorAll(".options");
            options.forEach(elm=>{
                let key = elm.key;
                if (key && currentSaveOptions[key]){
                    let elms = elm.querySelectorAll(".option");
                    elms.forEach(option=>{
                        option.classList.toggle("selected", option.value === currentSaveOptions[key]);
                    });
                }

                if (key === "depth"){
                    let paletteOption = optionsPanel.querySelector(".group.pal");
                    if (paletteOption){
                        paletteOption.classList.toggle("disabled",currentSaveOptions[key] === 24);
                    }
                }
            });
        }

    }

    function renderTextOutput(text){
        container.innerHTML = "";
        let textarea = $("textarea",{value:text});
        textarea.onkeydown = function(e){
            e.stopPropagation();
        }
        container.appendChild(textarea);
    }

    function renderButton(type,title,info,value){
        return $(".button.b"+type,{value:value},
            $(".icon."+type),
            $(".title",title),
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

    function waitFor(action,elm){
        let spinner = $(".spinner");
        elm.appendChild(spinner);
        elm.classList.add("loading");

        setTimeout(()=>{
            if (typeof action === "function") action = action();
            action.then((result)=>{
                spinner.remove();
                spinner.remove();
                elm.classList.remove("loading");
                if (result && result.messages && result.messages.length){
                    if (result.result === "warning" && result.file){
                        result.messages.unshift("Some issues were found while generating the file:");
                        result.messages.push("You might want to check the file.");
                    }
                    Modal.show(DIALOG.OPTION,{
                        title: result.title || result.result || "Alert",
                        text: result.messages,
                        buttons: [{label:"OK"}]
                    });
                }else{
                    if (result && !result.text){
                        Modal.hide();
                    }
                }
            });
        },50);
    }

    function getFileName(){
        let name = nameInput ? nameInput.value.replace(/[ &\/\\#,+()$~%.'":*?<>{}]/g, ""):"";
        return name || "Untitled"
    }

    async function writeFile(){
        let fileType = currentSaveOptions.fileType;
        if (!fileType) {
            console.error("Unknown file type",info.type);
            return;
        }
        let generator = fileType.generator;
        if (currentSaveOptions.depth === 8){
            if (generator === "PNG") generator = "PNG8";
            if (generator === "DPAINT") generator = "INDEXED";
        }
        if (generator === "ICO") generator = currentSaveOptions.iconType;

        let result = await Generate.file(generator,currentSaveOptions);
        if (result){
            console.error(result);
            if (result.file){
                await saveFile(result.file,getFileName() + "." + fileType.extension,fileType);
            }
            if (result.text){
                renderTextOutput(result.text);
            }
        }
        return result;
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
                    if (c<0) c=0;
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
        return result;
    }

    async function writeChunky(){
        let outputType = "binary";

        if (outputType === "text"){
            let output = [];
            output.push("static UWORD imagelist[] = {");
            let frameCount = ImageFile.getCurrentFile().frames.length;
            console.error(frameCount)

            for (let frame = 0; frame < frameCount; frame++){
                let image = ImageFile.getCanvas(frame);
                let imageData = image.getContext("2d").getImageData(0,0,image.width,image.height);
                let w = image.width;
                let h = image.height;
                let current = ""
                for (let y = 0; y < h; y++){
                    for (let x = 0; x < w; x++){
                        let index = (y * w + x) * 4;
                        let r = imageData.data[index];
                        let g = imageData.data[index + 1];
                        let b = imageData.data[index + 2];
                        let color = Color.toOCSString([r,g,b]);
                        current += color + ",";
                    }
                }
                output.push(current);
            }
            output.push("};");
            renderTextOutput(output.join("\n"));
        }else{

            let image = ImageFile.getCanvas();
            let w = image.width;
            let h = image.height;
            let frameCount = ImageFile.getCurrentFile().frames.length;

            let size = w * h * 2 * frameCount;

            let buffer = new ArrayBuffer(size);
            var file = BinaryStream(buffer,true);

            for (let frame = 0; frame < frameCount; frame++){
                let image = ImageFile.getCanvas(frame);
                let imageData = image.getContext("2d").getImageData(0,0,image.width,image.height);

                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        let index = (y * w + x) * 4;
                        let r = imageData.data[index] || 0 ;
                        let g = imageData.data[index + 1] || 0;
                        let b = imageData.data[index + 2] || 0;
                        let color = Color.toOCSString([r, g, b]);
                        let value = parseInt(color, 16);
                        file.writeWord(value);
                    }
                }
            }


            let blob = new Blob([file.buffer], {type: "application/octet-stream"});
            let fileName = getFileName() + '.chunky';
            await saveFile(blob,fileName,filetypes.FILE);


        }


    }



    async function writeINDEXED(){
        let result = await Generate.file("DPAINTINDEXED");
        if (result.file){
            await saveFile(result.file,getFileName() + '.json',filetypes.INDEXED);
        }
        return result;
    }

    function writeADF(){
        EventBus.trigger(COMMAND.SAVEFILETOADF,[currentFile,getFileName()]);
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

    EventBus.on(COMMAND.SAVEBRUSH,()=>{
        let struct = Brush.export();
        let blob = new Blob([JSON.stringify(struct,null,2)], { type: 'application/json' })
        saveFile(blob,getFileName() + '_brush.json',filetypes.PALETTE).then(()=>{

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