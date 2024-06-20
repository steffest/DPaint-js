let UserSettings = (()=>{
    let me = {};

    let settings = {};
    let stored = localStorage.getItem("dp_settings");
    if (stored){
        try {
            settings = JSON.parse(stored);
        }catch (e) {
            console.error("Could not parse settings", e);
            settings = {};
        }
    }


    me.get = (key)=>{
        return settings[key];
    }

    me.set = (key,value)=>{
        settings[key] = value;
        localStorage.setItem("dp_settings",JSON.stringify(settings));
    }

    return me;

})();

export default UserSettings;