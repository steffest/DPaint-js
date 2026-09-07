import ImageFile from "../image.js";
import { duplicateCanvas, releaseCanvas } from "../util/canvasUtils.js";
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4ArrayBufferTarget } from "../lib/mp4-muxer.js";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmArrayBufferTarget } from "../lib/webm-muxer.js";

const Video = (() => {
    const me = {};

    function isWebCodecsSupported() {
        return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
    }

    // Normalize the frame source to an async iterator of { canvas, release() }. Accepts either a
    // plain array of canvases (legacy, re-iterable, release is a no-op) or an async iterable of
    // OWNED frames { frame, release() } from ImageFile.iterateExportFrames — the bounded path that
    // composites one frame at a time and frees it once encoded.
    async function* normalizeFrames(source) {
        if (source && typeof source[Symbol.asyncIterator] === "function") {
            for await (const owned of source) {
                yield { canvas: owned.frame || owned.canvas, release: () => { if (owned.release) owned.release(); } };
            }
        } else {
            let arr = source || [];
            for (let i = 0; i < arr.length; i++) {
                yield { canvas: arr[i], release: () => {} };
            }
        }
    }

    // Upscale a source canvas by integer scale with nearest-neighbor interpolation.
    // Also ensure dimensions are even (divisible by 2) for H.264/VP9 encoder requirements.
    function scaleCanvas(sourceCanvas, scale) {
        let factor = parseInt(scale, 10) || 1;
        if (factor < 1) factor = 1;

        let targetWidth = sourceCanvas.width * factor;
        let targetHeight = sourceCanvas.height * factor;

        // Codecs like H.264 mandate even dimensions
        if (targetWidth % 2 !== 0) targetWidth += 1;
        if (targetHeight % 2 !== 0) targetHeight += 1;

        let canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        let ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = false;

        // Standard video containers (H.264/MP4 and most VP9 WebM players) do not support alpha.
        // Provide a solid background so transparent pixels do not produce color distortion.
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, targetWidth, targetHeight);

        // Draw scaled
        ctx.drawImage(
            sourceCanvas,
            0, 0, sourceCanvas.width, sourceCanvas.height,
            0, 0, sourceCanvas.width * factor, sourceCanvas.height * factor
        );

        // Fill 1px pad if dimension was odd
        if (targetWidth > sourceCanvas.width * factor) {
            ctx.drawImage(
                sourceCanvas,
                sourceCanvas.width - 1, 0, 1, sourceCanvas.height,
                sourceCanvas.width * factor, 0, 1, sourceCanvas.height * factor
            );
        }
        if (targetHeight > sourceCanvas.height * factor) {
            ctx.drawImage(
                sourceCanvas,
                0, sourceCanvas.height - 1, sourceCanvas.width, 1,
                0, sourceCanvas.height * factor, targetWidth, 1
            );
        }

        return canvas;
    }

    // Approach B: WebCodecs + Muxer (deterministic, high speed, accurate timestamps). Consumes the
    // frame source one frame at a time (see normalizeFrames) and releases each owned frame right
    // after it is encoded, so peak memory stays bounded regardless of the animation length.
    async function encodeWithWebCodecs(source, options) {
        let format = (options && options.videoFormat === "webm") ? "webm" : "mp4";
        let fps = (options && options.fps) || ImageFile.getFps() || 12;
        let scale = (options && options.scale) || 1;

        let iterator = normalizeFrames(source)[Symbol.asyncIterator]();
        let step = await iterator.next();
        if (step.done) throw new Error("No frames to encode");

        try {
            let firstScaled = scaleCanvas(step.value.canvas, scale);
            let width = firstScaled.width;
            let height = firstScaled.height;
            releaseCanvas(firstScaled);

            let isMp4 = format === "mp4";
            let target = isMp4 ? new Mp4ArrayBufferTarget() : new WebmArrayBufferTarget();

            // Configure codec
            let codecString = isMp4 ? "avc1.42001f" : "vp09.00.10.08"; // H.264 Baseline or VP9
            if (isMp4) {
                let isSupported = false;
                try {
                    let check = await VideoEncoder.isConfigSupported({
                        codec: codecString,
                        width,
                        height,
                        bitrate: 4_000_000
                    });
                    isSupported = check && check.supported;
                } catch (e) {
                    isSupported = false;
                }

                if (!isSupported) {
                    // Fallback to high/main profile or VP9 webm if MP4 codec config isn'\''t supported
                    codecString = "avc1.4d001f";
                }
            }

            let muxer = isMp4
                ? new Mp4Muxer({
                    target,
                    video: {
                        codec: "avc",
                        width,
                        height
                    },
                    fastStart: "in-memory"
                })
                : new WebmMuxer({
                    target,
                    video: {
                        codec: "V_VP9",
                        width,
                        height,
                        frameRate: fps
                    }
                });

            let encoderError = null;
            let videoEncoder = new VideoEncoder({
                output: (chunk, meta) => {
                    muxer.addVideoChunk(chunk, meta);
                },
                error: (e) => {
                    console.error("VideoEncoder error:", e);
                    encoderError = e;
                }
            });

            videoEncoder.configure({
                codec: codecString,
                width,
                height,
                bitrate: 4_000_000,
                framerate: fps
            });

            let frameDurationMicros = Math.round(1_000_000 / fps);

            let i = 0;
            while (!step.done) {
                if (encoderError) throw encoderError;

                let owned = step.value;
                let scaled = scaleCanvas(owned.canvas, scale);
                let timestampMicros = i * frameDurationMicros;

                let videoFrame = new VideoFrame(scaled, {
                    timestamp: timestampMicros,
                    duration: frameDurationMicros
                });

                // Insert keyframe at start and every 2 seconds
                let keyFrame = (i === 0 || (i % (fps * 2) === 0));
                videoEncoder.encode(videoFrame, { keyFrame });
                videoFrame.close();
                releaseCanvas(scaled);
                owned.release();

                i++;
                step = await iterator.next();
            }

            await videoEncoder.flush();
            videoEncoder.close();
            muxer.finalize();

            let buffer = target.buffer;
            let mimeType = isMp4 ? "video/mp4" : "video/webm";
            return new Blob([buffer], { type: mimeType });
        } finally {
            // On an early throw the frame just pulled is still owned by us; release it, then let
            // the iterator run its own cleanup (which frees the snapshot).
            if (step && !step.done && step.value && step.value.release) step.value.release();
            if (iterator.return) await iterator.return();
        }
    }

    // Fallback using MediaRecorder if WebCodecs is unavailable. Also streams the frame source one
    // frame at a time, releasing each owned frame after it is drawn onto the capture canvas.
    async function encodeWithMediaRecorder(source, options) {
        let format = (options && options.videoFormat === "webm") ? "webm" : "mp4";
        let fps = (options && options.fps) || ImageFile.getFps() || 12;
        let scale = (options && options.scale) || 1;

        let iterator = normalizeFrames(source)[Symbol.asyncIterator]();
        let step = await iterator.next();
        if (step.done) throw new Error("No frames to encode");

        let firstScaled = scaleCanvas(step.value.canvas, scale);
        let width = firstScaled.width;
        let height = firstScaled.height;
        releaseCanvas(firstScaled);

        let canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        let ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = false;

        let mimeType = (format === "mp4") ? "video/mp4" : "video/webm";
        if (MediaRecorder.isTypeSupported && !MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = "video/webm";
        }

        let stream = canvas.captureStream ? canvas.captureStream(0) : null;
        if (!stream) {
            if (step.value.release) step.value.release();
            if (iterator.return) await iterator.return();
            throw new Error("Canvas captureStream is not supported in this browser");
        }

        let recordedChunks = [];
        let recorder = new MediaRecorder(stream, { mimeType });
        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) recordedChunks.push(e.data);
        };

        let delayMs = Math.round(1000 / fps);

        return new Promise(async (resolve, reject) => {
            recorder.onerror = reject;
            recorder.onstop = () => {
                let blob = new Blob(recordedChunks, { type: mimeType });
                resolve(blob);
            };

            recorder.start();

            try {
                while (!step.done) {
                    let owned = step.value;
                    let scaled = scaleCanvas(owned.canvas, scale);
                    ctx.clearRect(0, 0, width, height);
                    ctx.drawImage(scaled, 0, 0);
                    releaseCanvas(scaled);
                    owned.release();

                    let track = stream.getVideoTracks()[0];
                    if (track && track.requestFrame) {
                        track.requestFrame();
                    }

                    await new Promise(r => setTimeout(r, delayMs));
                    step = await iterator.next();
                }
            } catch (err) {
                // The frame just pulled is still ours on an early throw; release it before the
                // iterator's own cleanup frees the snapshot.
                if (step && !step.done && step.value && step.value.release) step.value.release();
                reject(err);
                return;
            } finally {
                if (iterator.return) await iterator.return();
            }

            recorder.stop();
        });
    }

    me.write = async function (source, options) {
        options = options || {};
        let isIterable = source && typeof source[Symbol.asyncIterator] === "function";
        if (!source || (!isIterable && !source.length)) {
            throw new Error("No frames provided for video encoding");
        }

        if (isWebCodecsSupported()) {
            try {
                return await encodeWithWebCodecs(source, options);
            } catch (err) {
                // An async iterable is single-use and frees its snapshot once drained, so it
                // cannot be replayed through the fallback; only a re-iterable array can.
                if (isIterable) throw err;
                console.warn("WebCodecs encoding failed, falling back to MediaRecorder:", err);
                return await encodeWithMediaRecorder(source, options);
            }
        } else {
            return await encodeWithMediaRecorder(source, options);
        }
    };

    me.isSupported = function () {
        return isWebCodecsSupported() || (typeof MediaRecorder !== "undefined");
    };

    // The streaming (bounded-memory) export path is only safe when WebCodecs is available: it has
    // no re-iterable fallback. Callers use the eager array path otherwise.
    me.canStream = function () {
        return isWebCodecsSupported();
    };

    return me;
})();

export default Video;
