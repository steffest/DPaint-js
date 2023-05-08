let SyntaxEdit = function(parent,onChange){
    let me = {};

    let regexes={
        string1: {reg: /"(.*?)"/g, style:"string", wrap:'"'},
        string2: {reg: /'(.*?)'/g, style:"string", wrap:"'"},
        numbers: {reg: /(\b\d+\b)/g, style:"number"},
        hex: {reg: /(\B#\w+)/g, style:"number"},
        reserved: {reg: /\b(new|var|let|if|do|function|while|switch|for|foreach|in|continue|break)(?=[^\w])/g, style:"reserved"},
        globals: {reg: /\b(document|window|Array|String|Object|Number|Math|\$)(?=[^\w])/g, style:"globals"},
        js: {reg: /\b(getElementsBy(TagName|ClassName|Name)|getElementById|typeof|instanceof)(?=[^\w])/g, style:"js"},
        //methods: {reg:/((?<=\.)\w+)/g, style:"method"},
        // Note: Safari doesn't support lookbehind in regexes ...
        htmlTags: {reg: /(&lt;[^\&]*&gt;)/g, style:"html"},
        blockComments: {reg: /(\/\*.*\*\/)/g, style:"comment"},
        inlineComments: {reg: /(\/\/.*)/g, style:"comment"},
        source: {reg: /\b(source|\$)(?=[^\w])/g, style:"source"},
        target: {reg: /\b(target|\$)(?=[^\w])/g, style:"target"},
    }

    let editor = document.createElement("code");
    let textarea = document.createElement("textarea");
    editor.contentEditable = "true";
    editor.spellcheck = false;
    editor.onkeydown = (e)=>{
        e.stopPropagation();
    }
    editor.onblur = function(){
        onChange(editor.innerText);
        highlight();
    }
    parent.appendChild(editor);

    me.setValue=(value)=>{
        editor.innerText = value;
        highlight();
    }

    me.onChange =()=>{
        onChange(editor.innerText);
    }

    function highlight(){
        textarea.innerText=editor.innerText;
        let text = textarea.innerHTML;

        for (let key in regexes){
            let reg = regexes[key];
            let wrap = reg.wrap || "";
            text = text.replace(reg.reg,'<span class="' + reg.style + '">'+wrap+'$1'+wrap+'</span>');
        }

        editor.innerHTML = text;
    }


    return me;
}

export default SyntaxEdit;