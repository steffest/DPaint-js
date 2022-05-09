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
    NEWLAYER: 1015,
    SAVE: 1016
}

export let EVENT={
    drawColorChanged:1,
    backgroundColorChanged: 2,
    drawCanvasOverlay: 3,
    hideCanvasOverlay: 4,
    imageContentChanged: 5,
    imageSizeChanged: 6,
    layerContentChanged: 7,
}