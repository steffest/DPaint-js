export let COMMAND={
    NEW: 1001,
    OPEN: 1002,
    LINE:1003,
    SQUARE:1004,
    ZOOMIN:1005,
    ZOOMOUT:1006,
    SELECT: 1007,
    DRAW:1008,
    SPLITSCREEN: 1009,
    UNDO: 1010,
    REDO: 1011,
    STAMP: 1012,
    TOLAYER: 1013,
    CLEARSELECTION: 1014,
    ERASEELECTION: 1015,
    NEWLAYER: 1016,
    SAVE: 1017,
    PALETTEFROMIMAGE: 1018,
    PALETTEREDUCE: 1019,
    ROTATE: 1020,
    CLEAR: 1021,
    CROP: 1022,
    INFO: 1023,
    ERASE: 1024,
    DELETELAYER: 1025,
    CIRCLE: 1026,
    TRIM: 1027,
    TRANSFORMLAYER: 1028,
    ADDFRAME: 1029,
    DELETEFRAME: 1030,
    IMPORTFRAME: 1031,
    RESIZE: 1032,
    RESAMPLE: 1033,
    SHARPEN: 1034,
    BLUR: 1035,
    DUPLICATELAYER: 1036,
    COLORMASK: 1037,
    EDITPALETTE: 1038,
    MERGEDOWN: 1039,
    FLATTEN: 1040,
    LAYERUP: 1041,
    LAYERDOWN: 1042,
    GRADIENT: 1043,
    SAVEPALETTE: 1044,
    LOADPALETTE: 1045,
}

export let EVENT={
    drawColorChanged:1,
    backgroundColorChanged: 2,
    drawCanvasOverlay: 3,
    hideCanvasOverlay: 4,
    imageContentChanged: 5,
    imageSizeChanged: 6,
    layerContentChanged: 7,
    selectionChanged: 8,
    sizerChanged: 9,
    toolDeActivated: 10,
    layersChanged: 11,
    modifierKeyChanged:12,
    toolChanged: 13

}