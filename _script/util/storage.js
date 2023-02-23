let Storage = function(){
    let me = {}
    let typeData = {};

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

    return me;
}();

export default Storage;