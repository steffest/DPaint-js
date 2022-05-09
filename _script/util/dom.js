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