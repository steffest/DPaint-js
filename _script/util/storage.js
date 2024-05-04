let Storage = function(){
    let me = {}
    let typeData = {};
    let dbName = "dpaintjs";

    me.put=(type,content,index)=>{
        typeData[type] = typeData[type] || [];
        if (typeof index === "number"){
            typeData[type][index] = content;
        }else{
            typeData[type].push(content);
        }
        localStorage.setItem("dp_"+type,JSON.stringify(typeData[type]));
    }

    me.get=(type,index)=>{
        if (typeData[type]) return typeData[type];

        let s = localStorage.getItem("dp_" + type);
        if (s){
            try{s=JSON.parse(s)}catch (e){s=[]}
        }
        typeData[type] = s;
        return s;
    }

    me.remove=(type,index)=>{
        typeData[type] = typeData[type] || [];
        typeData[type].splice(index,1);
        localStorage.setItem("dp_"+type,JSON.stringify(typeData[type]));
    }

    me.putFile = function(path,content){
        return new Promise(async (next)=>{
            let db = await openDb();
            let transaction = db.transaction(["files"], "readwrite");
            transaction.onerror = (event) => {
                console.error("Transaction error",event.target.error);
            };
            const objectStore = transaction.objectStore("files");
            const request = objectStore.put({ path: path, content: content });
            request.onsuccess = (event) => {
                next();
            }
            request.onerror = (event) => {
                console.error("Storage put failed",event.target.error);
                next();
            }
        });
    }

    me.getFile = function(path){
        return new Promise(async (next)=>{
            let db = await openDb();
            let transaction = db.transaction(["files"]);
            transaction.onerror = (event) => {
                console.error("Transaction error",event.target.error);
            }
            const objectStore = transaction.objectStore("files");
            const getRequest = objectStore.get(path);
            getRequest.onsuccess = (event) => {
                let result = event.target.result;
                if (result && result.content) result = result.content;
                next(result);
            }
            getRequest.onerror = (event) => {
                console.error("Storage get failed",event.target.error);
                next();
            }
        });
    }

    function openDb(){
        return new Promise(function(next){
            let request = window.indexedDB.open(dbName, 1);
            request.onerror = function(event) {
                console.error("Error opening db",event.target.error.name);
                if (event.target.error.name === "VersionError"){
                    console.error("VersionError",event.target.error.name);
                    window.indexedDB.deleteDatabase(dbName);
                    request = window.indexedDB.open(dbName, 1);
                }else{
                    next(undefined);
                }
            }
            request.onsuccess = function(event) {
                next(event.target.result);
            }

            request.onupgradeneeded = (event) => {
                let db = event.target.result;
                let settings = db.createObjectStore("settings", { keyPath: "key" });
                let files = db.createObjectStore("files", { keyPath: "path" });
                settings.createIndex("key", "key", { unique: true });
                files.createIndex("path", "path", { unique: true });
            }
        });
    }

    return me;
}();

export default Storage;