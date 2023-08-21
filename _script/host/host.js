import AmiBase from "./amibase.js";
import ImageFile from "../image.js";
import Amibase from "./amibase.js";

let Host = function(){
    let me = {};
    let currentFile;

    me.init = function(){
        AmiBase.init().then(isAmiBase=>{
            if (isAmiBase){
                console.log("AmiBase is available");
                AmiBase.setMessageHandler(message=>{
                    console.error(message);

                    var command = message.message;
                    if (!command) return;
                    if (command.indexOf("amibase_")>=0) command=command.replace("amibase_","");

                    switch(command){
                        case 'dropFile':
                        case 'openFile':
                            // amiBase requests to open a file in Monaco
                            let file = message.data;
                            currentFile = file;
                            if (file && file.data){
                                // we already have the content of the file
                                loadFile(file.data,file.path);
                            }else{
                                // we need to request the file from AmiBase
                                AmiBase.readFile(currentFile.path,true).then(data=>{
                                    loadFile(data,currentFile.path);
                                });
                            }
                            break;
                    }
                });
                AmiBase.iAmReady();
            }
        });
    }

    me.saveFile = function(blob,fileName){
        AmiBase.requestFileSave(currentFile.path).then(file=>{
            if (file && file.path){
               AmiBase.writeFile(file.path,blob,true).then(result=>{
                   console.log(result);
                   AmiBase.activateWindow();
               });
            }
        });
    }

    function loadFile(data,path){
        let fileName = path.split("/").pop();
        console.log("load file",typeof data);
        ImageFile.handleBinary(data,fileName,"file",true);
        //SaveDialog.setFile(file);
    }

    return me;
}();

export default Host;