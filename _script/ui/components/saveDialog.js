import {$div} from "../../util/dom.js";
import IFF from "../../fileformats/iff.js";
import ImageFile from "../../image.js";
import saveAs from "../../util/filesaver.js";
import Modal from "../modal.js";

var SaveDialog = function(){
    let me ={};

    let filetypes = {
        IFF:{
            description: 'IFF ILMB Image',
            accept: {
                'image/x-ilbm': ['.iff'],
            },
        },
        PNG:{
            description: 'PNG Image',
            accept: {
                'image/png': ['.png'],
            },
        }
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
        container.appendChild(renderButton("Save as IFF","Amiga IFF file",writeIFF));
        container.appendChild(renderButton("Save as PNG","PNG file",writePNG));
    }

    function renderButton(title,subtitle,onClick){
        let button = $div("button","",undefined,onClick);
        $div("title",title,button);
        $div("subtitle",subtitle,button);
        return button;
    }

    function writeIFF(){
        var buffer = IFF.write(ImageFile.getCanvas());

        var blob = new Blob([buffer], {type: "application/octet-stream"});
        var fileName = 'test.iff';
        saveFile(blob,fileName,filetypes.IFF).then(()=>{
            Modal.hide();
        });
    }

    function writePNG(){
        ImageFile.getCanvas().toBlob(function(blob) {
            saveFile(blob,"test.png",filetypes.PNG).then(()=>{
                Modal.hide();
            });
        });
    }


    return me;
}();

export default SaveDialog;