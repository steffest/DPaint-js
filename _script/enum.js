export let COMMAND = {
    NEW: 1001,
    OPEN: 1002,
    LINE: 1003,
    SQUARE: 1004,
    ZOOMIN: 1005,
    ZOOMOUT: 1006,
    SELECT: 1007,
    DRAW: 1008,
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
    IMPORTLAYER: 1031,
    RESIZE: 1032,
    RESAMPLE: 1033,
    EFFECTS: 1034,
    GRADIENT: 1035,
    DUPLICATELAYER: 1036,
    COLORMASK: 1037,
    EDITPALETTE: 1038,
    MERGEDOWN: 1039,
    FLATTEN: 1040,
    LAYERUP: 1041,
    LAYERDOWN: 1042,
    SAVEPALETTE: 1043,
    LOADPALETTE: 1044,
    LAYERMASK: 1045,
    LAYERMASKHIDE: 1046,
    DELETELAYERMASK: 1047,
    APPLYLAYERMASK: 1048,
    POLYGONSELECT: 1049,
    ENDPOLYGONSELECT: 1050,
    TOSELECTION: 1051,
    CUTTOLAYER: 1052,
    SWAPCOLORS: 1053,
    ABOUT: 1054,
    FLOODSELECT: 1055,
    FLOOD: 1056,
    SELECTALL: 1057,
    COPY: 1058,
    PASTE: 1059,
    FULLSCREEN: 1060,
    PAN: 1061,
    COLORPICKER: 1062,
    TOGGLEPALETTES: 1063,
    ADF: 1064,
    DELUXE: 1065,
    SAVEDISK: 1066,
    SAVEGENERIC: 1067,
    SAVEFILETOADF: 1068,
    DUPLICATEFRAME: 1069,
    SMUDGE: 1070,
    CYCLEPALETTE: 1071,
    LOCKPALETTE: 1072,
    FLIPHORIZONTAL: 1073,
    FLIPVERTICAL: 1074,
    PRESENTATION: 1075,
    TOGGLEGRID: 1076,
    TOGGLEMASK: 1077,
    TOGGLEOVERRIDE: 1078,
    TOGGLEINVERT: 1079,
    ZOOMFIT: 1080,
    COLORSELECT: 1081,
    ALPHASELECT: 1082,
    TOGGLESIDEPANEL: 1083,
    TOGGLEGALLERY: 1084,
    INITSELECTION: 1085,
    DISABLELAYERMASK: 1086,
    ENABLELAYERMASK: 1087,
    TOGGLEDITHER: 1088,
    SPRAY: 1089,
    TEXT: 1090,
    BRUSHROTATERIGHT: 1091,
    BRUSHROTATELEFT: 1092,
    BRUSHFLIPHORIZONTAL: 1093,
    BRUSHFLIPVERTICAL: 1094,
    SAVEBRUSH: 1095,
    LOADBRUSH: 1096,
    TOGGLEPIXELGRID: 1097,
    COLORDEPTH24: 1098,
    COLORDEPTH12: 1099,
    COLORDEPTH9: 1100,
    ADDPALETTE: 1101,
    NEXTPALETTE: 1102,
    PREVPALETTE: 1103,
    FRAMEMOVETOEND: 1104,

};

export let EVENT = {
    drawColorChanged: 1,
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
    modifierKeyChanged: 12,
    toolChanged: 13,
    toolOptionsChanged: 14,
    brushOptionsChanged: 15,
    colorCount: 16,
    layerContentHistory: 17,
    imageHistory: 18,
    selectionHistory: 19,
    paletteHistory: 20,
    historyChanged: 21,
    endPolygonSelect: 22,
    framesChanged: 23,
    UIresize: 24,
    paletteChanged: 25,
    colorCycleChanged: 26,
    colorCycleToggled: 27,
    colorRangeChanged: 28,
    colorRangesChanged: 29,
    gridOptionsChanged: 30,
    layerPropertyHistory: 31,
    layerHistory: 32,
    sizerStartChange: 33,
    panelResized: 34,
    fontStyleChanged: 35,
    colorDepthChanged: 36,
    previewModeChanged: 37,
    paletteProcessingStart: 38,
    paletteProcessingEnd: 39,
};

export let ANIMATION = {
    CYCLE: 1,
    SPRAY: 2,
    TEXT: 3,
}
