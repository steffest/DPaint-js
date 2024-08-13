export default function dom(tagName,options){
	let elm;
	let opt = {};
	let index = 1;
	let hasParent = false;
	if (typeof options === "object" && !Array.isArray(options) && !(options instanceof Element)){
		opt = options;
		index++;
	}

	if (tagName instanceof Element){
		elm = tagName;
	}else{
		// allow tag.class and tag#id constructors
		if (tagName.indexOf(".")>=0){
			let classNames = tagName.split(".");
			tagName = classNames.shift();
			opt.className = ((opt.className || "") + " " +  classNames.join(" ")).trim();
		}
		if (tagName.indexOf("#")>=0){
			let p = tagName.split("#");
			tagName = p.shift();
			opt.id = p[0];
		}
		tagName = tagName||"div";
		elm = document.createElement(tagName);
	}


	for (let key in opt) {
		if (key === 'parent'){
			opt[key].appendChild(elm);
			hasParent = true;
			continue;
		}

		// custom dpaint.js stuff
		if (key === 'onClick') addClass(elm,opt,"handle");
		if (key === 'onDrag') addClass(elm,opt,"handle");
		if (key === 'info') addClass(elm,opt,"info");
		// end custom dpaint.js stuff

		if (key==="style" && typeof opt[key] === "object"){
			for (let style in opt[key]){
				elm.style[style] = opt[key][style];
			}
			continue;
		}

		elm[key] = opt[key];
	}

	for (; index < arguments.length; index++) {
		append(elm, arguments[index]);
	}

	if (defaultParent && !hasParent) defaultParent.appendChild(elm);
	return elm;
}

export function $div(classname,innerHTML,parent,onClick){
	let result = document.createElement("div");
	if (classname) result.className = classname;
	if (innerHTML) result.innerHTML = innerHTML;
	if (onClick){
		result.onClick = onClick;
		result.classList.add("handle");
	}
	if (parent) parent.appendChild(result);
	return result;
}

export function $link(classname,innerHTML,parent,onClick){
	let result = document.createElement("a");
	if (classname) result.className = classname;
	if (innerHTML) result.innerHTML = innerHTML;
	if (onClick) result.onClick = onClick;
	if (parent) parent.appendChild(result);
	return result;
}

export function $title(level,innerHTML,parent){
	let result = document.createElement("h" + level);
	if (innerHTML) result.innerHTML = innerHTML;
	if (parent) parent.appendChild(result);
	return result;
}

export function $elm(type,innerHTML,parent,classname){
	let result = document.createElement(type);
	if (innerHTML) result.innerHTML = innerHTML;
	if (classname) result.className = classname;
	if (parent) parent.appendChild(result);
	return result;
}
export function $checkbox(label,parent,classname,onToggle,checked){

	let result = document.createElement("span");
	result.className = "checkbox";

	let labelElm = document.createElement("label");
	let checkbox = document.createElement("input");
	checkbox.type="checkbox";
	checkbox.checked = !!checked;
	let textElm = document.createElement("span");
	labelElm.appendChild(checkbox);
	labelElm.appendChild(textElm);
	if (label) textElm.innerText = label;
	result.appendChild(labelElm);

	if (onToggle){
		checkbox.oninput = ()=>{
			onToggle(checkbox.checked)
		};
	}
	if (classname) result.className += " " + classname;
	if (parent) parent.appendChild(result);
	result.setState = (state)=>{
		checkbox.checked = !!state;
	}
	return result;
}

export function $input(type,value,parent,onInput){
	let result = document.createElement("input");
	result.type = type || "text";
	if (typeof value !== "undefined") result.value = value;
	if (onInput){
		result.oninput = onInput;
	}
	if (parent) parent.appendChild(result);
	return result
}




let append = (parent, child) => {
	if (child) {
		if (Array.isArray(child)) {
			child.map(sub => append(parent, sub));
		} else {
			if (typeof child === "string") child = document.createTextNode(child);
			parent.appendChild(child);
		}
	}
};

let addClass=(elm,opt,className)=>{
	elm.classList.add(className);
	if (opt.className) opt.className += " " + className;
}

let defaultParent;

// TODO move to new Dom constructor


export function $setTarget(parent){
	defaultParent = parent
}
