import {SETTING} from "./enum.js";

let UserSettings = (()=>{
    let me = {};

    const getDefaultSettings = ()=>{
        let result = {};
        result["touchRotate"] = true;
        result["useMultiPalettes"] = false;
        return result;
    }

    let settings = getDefaultSettings();
    let stored = localStorage.getItem("dp_settings");
    if (stored){
        try {
            settings = JSON.parse(stored);
        }catch (e) {
            console.error("Could not parse settings", e);
            settings = getDefaultSettings();
        }
    }
    
    // update SETTING from settings
    for (let key in SETTING){
        if (settings[key] !== undefined){
            SETTING[key] = settings[key];
        }
    }


    me.get = (key)=>{
        return settings[key];
    }

    me.set = (key,value,updateSETTING)=>{
        settings[key] = value;
        localStorage.setItem("dp_settings",JSON.stringify(settings));
        if (updateSETTING) SETTING[key] = value;
    }

    return me;

})();

export default UserSettings;