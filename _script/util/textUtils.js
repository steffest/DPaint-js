export function DuplicateName(name, layers) {
    const existingNames = new Set(layers.map(layer => layer.name));
    const nameExists = (name) => existingNames.has(name);

    let baseName = name;

    const duplicateIndex = name.indexOf(" duplicate");
    if (duplicateIndex !== -1) baseName = name.substring(0, duplicateIndex);

    let newName = baseName + " duplicate";
    if (!nameExists(newName)) return newName;

    let counter = 2;
    do {
        newName = `${baseName} duplicate ${counter}`;
        counter++;
    } while (nameExists(newName));

    return newName;
}