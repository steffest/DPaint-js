import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT, SETTING} from "../enum.js";
import ImageFile from "../image.js";
import Palette from "../ui/palette.js";
import {runWebGLQuantizer} from "../util/webgl-quantizer.js";
import UserSettings from "../userSettings.js";

let Recorder = (()=>{
    let me = {};
    let recordedChunks = [];
    let mediaRecorder = null;
    let isRecording = false;
    let recordingCanvas = null;
    let recordingCtx = null;
    let stream = null;
    let recordingDrawWidth = 0;
    let recordingDrawHeight = 0;
    
    // Simple configuration for timelapse
    const config = {
        framerate: 20,
        maxWidth: 1280,
        maxHeight: 720,
        bitrate: 2000000  // 2 Mbps
    };

    const qualityPresets = {
        standard: {
            maxWidth: 1280,
            maxHeight: 720,
            bitrate: 2000000
        },
        high: {
            maxWidth: 1920,
            maxHeight: 1080,
            bitrate: 6000000
        },
        best: {
            maxWidth: 0,
            maxHeight: 0,
            bitrate: 12000000
        }
    };

    function getRecorderQuality() {
        let quality = UserSettings.get("recorderQuality") || "standard";
        return qualityPresets[quality] ? quality : "standard";
    }

    function getRecordingConfig(sourceCanvas) {
        let preset = qualityPresets[getRecorderQuality()];

        let maxWidth = preset.maxWidth || sourceCanvas.width;
        let maxHeight = preset.maxHeight || sourceCanvas.height;

        return {
            framerate: config.framerate,
            maxWidth,
            maxHeight,
            bitrate: preset.bitrate
        };
    }

    function getRecordingDimensions(sourceCanvas, recordingConfig) {
        const widthScale = recordingConfig.maxWidth / sourceCanvas.width;
        const heightScale = recordingConfig.maxHeight / sourceCanvas.height;
        const maxScale = Math.min(widthScale, heightScale);

        let drawWidth;
        let drawHeight;

        if (maxScale >= 1) {
            const integerScale = Math.max(1, Math.floor(maxScale));
            drawWidth = sourceCanvas.width * integerScale;
            drawHeight = sourceCanvas.height * integerScale;
        } else {
            const scale = Math.max(0.01, maxScale);
            drawWidth = Math.max(1, Math.round(sourceCanvas.width * scale));
            drawHeight = Math.max(1, Math.round(sourceCanvas.height * scale));
        }

        return {
            drawWidth,
            drawHeight,
            canvasWidth: drawWidth + (drawWidth % 2),
            canvasHeight: drawHeight + (drawHeight % 2)
        };
    }

    function drawFrame(sourceCanvas) {
        if (!recordingCtx || !recordingCanvas) return;

        recordingCtx.clearRect(0, 0, recordingCanvas.width, recordingCanvas.height);
        recordingCtx.drawImage(sourceCanvas, 0, 0, recordingDrawWidth, recordingDrawHeight);

        if (recordingCanvas.width > recordingDrawWidth) {
            recordingCtx.drawImage(
                sourceCanvas,
                sourceCanvas.width - 1, 0, 1, sourceCanvas.height,
                recordingDrawWidth, 0, recordingCanvas.width - recordingDrawWidth, recordingDrawHeight
            );
        }

        if (recordingCanvas.height > recordingDrawHeight) {
            recordingCtx.drawImage(
                sourceCanvas,
                0, sourceCanvas.height - 1, sourceCanvas.width, 1,
                0, recordingDrawHeight, recordingDrawWidth, recordingCanvas.height - recordingDrawHeight
            );
        }

        if (recordingCanvas.width > recordingDrawWidth && recordingCanvas.height > recordingDrawHeight) {
            recordingCtx.drawImage(
                sourceCanvas,
                sourceCanvas.width - 1, sourceCanvas.height - 1, 1, 1,
                recordingDrawWidth, recordingDrawHeight,
                recordingCanvas.width - recordingDrawWidth,
                recordingCanvas.height - recordingDrawHeight
            );
        }
    }
    
    // Detect best supported format
    function getSupportedMimeType() {
        if (!MediaRecorder || !MediaRecorder.isTypeSupported) {
            return 'video/webm';
        }
        
        const types = [
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm',
            'video/mp4;codecs=h264',
            'video/mp4'
        ];
        
        for (let type of types) {
            if (MediaRecorder.isTypeSupported(type)) {
                console.log('Using format:', type);
                return type;
            }
        }
        
        return 'video/webm'; // fallback
    }

    // Clean up resources
    me.cleanup = function() {
        isRecording = false;
        recordedChunks = [];
        
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
        }
        
        if (recordingCanvas) {
            recordingCanvas.width = 1;
            recordingCanvas.height = 1;
            recordingCanvas = null;
            recordingCtx = null;
        }
        recordingDrawWidth = 0;
        recordingDrawHeight = 0;
        
        mediaRecorder = null;
    };

    function getSourceCanvas(){
        if (window.override) {
            let frame = ImageFile.getActiveFrame();
            if (frame && frame.layers){
                let hasHidden = frame.layers.some(layer => layer.name && layer.name.indexOf("_") === 0);

                if (hasHidden){
                    let canvas = document.createElement("canvas");
                    let currentFile = ImageFile.getCurrentFile();
                    canvas.width = currentFile.width;
                    canvas.height = currentFile.height;
                    let ctx = canvas.getContext("2d");

                    frame.layers.forEach((layer) => {
                        if (layer.visible && layer.name.indexOf("_") !== 0) {
                            ctx.globalAlpha = layer.opacity / 100;
                            let blendMode = layer.blendMode || "normal";
                            if (blendMode === "normal") blendMode = "source-over";
                            ctx.globalCompositeOperation = blendMode;
                            ctx.drawImage(layer.render(), 0, 0);
                            ctx.globalAlpha = 1;
                            ctx.globalCompositeOperation = "source-over";
                        }
                    });
                    return canvas;
                }
            }
        }
        return ImageFile.getCanvas();
    }

    // Start recording
    me.startRecording = function() {
        if (!MediaRecorder) {
            alert('Video recording not supported in this browser');
            return;
        }
        
        if (isRecording) {
            alert('Recording already in progress');
            return;
        }
        
        try {
            const sourceCanvas = getSourceCanvas();
            const recordingConfig = getRecordingConfig(sourceCanvas);
            const dimensions = getRecordingDimensions(sourceCanvas, recordingConfig);
            
            // Create recording canvas
            recordingCanvas = document.createElement('canvas');
            recordingCanvas.width = dimensions.canvasWidth;
            recordingCanvas.height = dimensions.canvasHeight;
            recordingCtx = recordingCanvas.getContext('2d');
            recordingCtx.imageSmoothingEnabled = false;
            recordingDrawWidth = dimensions.drawWidth;
            recordingDrawHeight = dimensions.drawHeight;
            
            // Draw initial frame
            drawFrame(sourceCanvas);
            
            if (Palette.isLockedGlobal()){
                runWebGLQuantizer(recordingCanvas, Palette.get(), false, undefined, 0, 0);
            }

            // Create stream
            stream = recordingCanvas.captureStream(recordingConfig.framerate);
            
            // Create recorder
            const mimeType = getSupportedMimeType();
            mediaRecorder = new MediaRecorder(stream, {
                mimeType: mimeType,
                videoBitsPerSecond: recordingConfig.bitrate
            });
            
            recordedChunks = [];
            
            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    recordedChunks.push(e.data);
                }
            };
            
            mediaRecorder.onstop = () => {
                me.download();
            };
            
            mediaRecorder.onerror = (e) => {
                console.error('Recording error:', e);
                alert('Recording failed');
                me.cleanup();
            };
            
            mediaRecorder.start();
            // immediately pause to wait for the first action
            mediaRecorder.pause();
            isRecording = true;
            
            console.log(`Recording started: ${recordingCanvas.width}x${recordingCanvas.height} (content ${recordingDrawWidth}x${recordingDrawHeight}) @ ${recordingConfig.bitrate}bps`);
            
        } catch (error) {
            console.error('Failed to start recording:', error);
            alert('Recording failed: ' + error.message);
            me.cleanup();
        }
    };

    // Stop and download recording
    me.stopAndDownload = function() {
        if (!isRecording || !mediaRecorder) {
            alert('No active recording');
            return;
        }
        
        isRecording = false;
        
        if (mediaRecorder.state === "paused") {
            mediaRecorder.resume();
        }
        mediaRecorder.stop();
    };
    
    // Download the recording
    me.download = function() {
        if (!recordedChunks.length) {
            alert('No data to download');
            me.cleanup();
            return;
        }
        
        const mimeType = getSupportedMimeType();
        const blob = new Blob(recordedChunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `dpaint-timelapse-${Date.now()}.${mimeType.includes('webm') ? 'webm' : 'mp4'}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        URL.revokeObjectURL(url);
        me.cleanup();
        
        console.log('Recording downloaded');
    };

    // Capture current frame
    me.captureFrame = function() {
        if (!isRecording || !recordingCanvas || !recordingCtx) return;
        
        if (mediaRecorder.state === "paused") {
            mediaRecorder.resume();
        }

        const sourceCanvas = getSourceCanvas();
        drawFrame(sourceCanvas);
        
        if (Palette.isLockedGlobal()){
            runWebGLQuantizer(recordingCanvas, Palette.get(), false, undefined, 0, 0);
        }

        setTimeout(()=>{
            if (isRecording && mediaRecorder && mediaRecorder.state === "recording") {
                mediaRecorder.pause();
                console.log("recorder paused");
            }
        },100);

        console.log("Frame captured");
    };

    // Event handlers
    EventBus.on(COMMAND.RECORDINGSTART, me.startRecording);
    EventBus.on(COMMAND.RECORDINGSTOP, me.stopAndDownload);
    EventBus.on(COMMAND.RECORDINGEXPORT, me.stopAndDownload);
    
    // Capture frames on history changes (undo points)
    EventBus.on(EVENT.historyChanged, () => {
        if (isRecording) {
            me.captureFrame();
        }
    });
    
    // Public API
    me.isRecording = () => isRecording;

    me.clear = me.cleanup;

    return me;
})();

export default Recorder;
