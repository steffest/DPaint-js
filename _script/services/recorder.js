import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT, SETTING} from "../enum.js";
import ImageFile from "../image.js";
import Palette from "../ui/palette.js";
import {runWebGLQuantizer} from "../util/webgl-quantizer.js";

let Recorder = (()=>{
    let me = {};
    let recordedChunks = [];
    let mediaRecorder = null;
    let isRecording = false;
    let recordingCanvas = null;
    let recordingCtx = null;
    let stream = null;
    
    // Simple configuration for timelapse
    const config = {
        framerate: 20,
        maxWidth: 1280,
        maxHeight: 720,
        bitrate: 2000000  // 2 Mbps
    };
    
    // Detect best supported format
    function getSupportedMimeType() {
        if (!MediaRecorder || !MediaRecorder.isTypeSupported) {
            return 'video/webm';
        }
        
        const types = [
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm',
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
        
        mediaRecorder = null;
    };

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
            const sourceCanvas = ImageFile.getCanvas();
            
            // Calculate recording size maintaining aspect ratio
            const aspectRatio = sourceCanvas.width / sourceCanvas.height;
            let width = Math.min(sourceCanvas.width, config.maxWidth);
            let height = Math.min(sourceCanvas.height, config.maxHeight);
            
            if (width / height > aspectRatio) {
                width = height * aspectRatio;
            } else {
                height = width / aspectRatio;
            }
            
            // Ensure even dimensions
            width = Math.floor(width / 2) * 2;
            height = Math.floor(height / 2) * 2;
            
            // Create recording canvas
            recordingCanvas = document.createElement('canvas');
            recordingCanvas.width = width;
            recordingCanvas.height = height;
            recordingCtx = recordingCanvas.getContext('2d');
            recordingCtx.imageSmoothingEnabled = true;
            
            // Draw initial frame
            recordingCtx.drawImage(sourceCanvas, 0, 0, width, height);
            
            if (Palette.isLockedGlobal()){
                runWebGLQuantizer(recordingCanvas, Palette.get(), false, undefined, 0, 0);
            }

            // Create stream
            stream = recordingCanvas.captureStream();
            
            // Create recorder
            const mimeType = getSupportedMimeType();
            mediaRecorder = new MediaRecorder(stream, {
                mimeType: mimeType,
                videoBitsPerSecond: config.bitrate
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
            
            console.log(`Recording started: ${width}x${height}`);
            
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

        const sourceCanvas = ImageFile.getCanvas();
        recordingCtx.drawImage(sourceCanvas, 0, 0, recordingCanvas.width, recordingCanvas.height);
        
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
