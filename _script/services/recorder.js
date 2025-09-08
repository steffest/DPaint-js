import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import ImageFile from "../image.js";
import {duplicateCanvas} from "../util/canvasUtils.js";

let Recorder = (()=>{
    let me = {};
    let recordedChunks = [];
    let frames = [];
    let mediaRecorder;
    let format = "mp4";
    let isRecording = false;
    let canvas;
    let ctx;
    let stream;

    let recordOnTheFly = false;

    me.clear = function(){
        recordedChunks = [];
        frames = [];
        canvas = undefined;
    }

        EventBus.on(COMMAND.RECORDINGSTART,()=>{
        if (window.MediaRecorder) {
            if (recordOnTheFly){
                const firstFrame = ImageFile.getCanvas();
                const width = firstFrame.width;
                const height = firstFrame.height;

                canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                ctx = canvas.getContext('2d');

                stream = canvas.captureStream(25); // 25 fps
                mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/mp4' });

                mediaRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0) {
                        recordedChunks.push(e.data);
                    }
                };

                mediaRecorder.onstop = () => {
                    const blob = new Blob(recordedChunks, { type: 'video/' + format });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'recording.' + format;
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => {
                        document.body.removeChild(a);
                        window.URL.revokeObjectURL(url);
                        me.clear();
                    }, 0);
                };

                mediaRecorder.start();
                isRecording = true;
                EventBus.trigger(EVENT.historyChanged,[0,0]);
            }else{
                isRecording = true;
                frames.push(duplicateCanvas(ImageFile.getCanvas(),true));
            }
        }else{
            alert("Recording not supported in this browser");
        }
    })

    EventBus.on(COMMAND.RECORDINGSTOP,()=>{
        isRecording = false;
    })

    EventBus.on(COMMAND.RECORDINGEXPORT,()=>{
        if (recordOnTheFly){
            if (mediaRecorder) mediaRecorder.stop();
        }else{
            if (frames.length > 0) {
                const firstFrame = frames[0];
                const width = firstFrame.width;
                const height = firstFrame.height;

                canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                ctx = canvas.getContext('2d');

                stream = canvas.captureStream(25); // 25 fps
                mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/mp4' });

                mediaRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0) {
                        recordedChunks.push(e.data);
                    }
                };

                mediaRecorder.onstop = () => {
                    const blob = new Blob(recordedChunks, { type: 'video/' + format });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'recording.' + format;
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => {
                        document.body.removeChild(a);
                        window.URL.revokeObjectURL(url);
                        me.clear();
                    }, 0);
                };

                mediaRecorder.start();

                let frameIndex = 0;
                function drawFrame() {
                    if (frameIndex < frames.length) {
                        ctx.drawImage(frames[frameIndex], 0, 0);
                        requestAnimationFrame(drawFrame);
                        frameIndex++;
                    } else {
                        mediaRecorder.stop();
                    }
                }

                drawFrame();
            }
        }
    })

    EventBus.on(EVENT.historyChanged,()=>{
        if (isRecording){
            if (recordOnTheFly){
                if (ctx) ctx.drawImage(ImageFile.getCanvas(), 0, 0);
                if (stream && stream.getVideoTracks && stream.getVideoTracks().length>0){
                    let track = stream.getVideoTracks()[0];
                    if (track.requestFrame){
                        console.log("record frame");
                        track.requestFrame();
                    }
                }
            }else{
                frames.push(duplicateCanvas(ImageFile.getCanvas(),true));
            }
        }
    })

    return me;
})();

export default Recorder;