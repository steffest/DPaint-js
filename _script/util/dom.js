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
export function $checkbox(label,parent,classname,onToggle){

	let result = document.createElement("span");
	result.className = "checkbox";

	let labelElm = document.createElement("label");
	let checkbox = document.createElement("input");
	checkbox.type="checkbox";
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