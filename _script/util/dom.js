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

	let checkbox = document.createElement("input");
	checkbox.type="checkbox";
	result.appendChild(checkbox);

	if (label){
		checkbox.id="cb" + Math.floor(Math.random()*1000000);
		let labelElm = document.createElement("label");
		labelElm.innerHTML=label;
		labelElm.htmlFor = checkbox.id;
		result.appendChild(labelElm);
	}

	if (onToggle){
		checkbox.oninput = ()=>{
			onToggle(checkbox.checked)
		};
	}
	if (classname) result.className = classname;
	if (parent) parent.appendChild(result);
	return result;
}