const bayerMatrix = [
    0, 32, 8, 40, 2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37,
    63, 31, 55, 23, 61, 29, 53, 21
].map(x => x / 64.0);

const halftoneMatrix4x4 = [
    14, 10,  9, 13,
    11,  6,  5, 12,
    7,  2,  1,  8,
    3,  0,  4, 15
].map(x => x / 16.0);

const vertexShaderSource = `
    attribute vec2 a_position;
    varying vec2 v_texCoord;
    void main() {
        gl_Position = vec4(a_position, 0, 1);
        v_texCoord = a_position * 0.5 + 0.5;
    }
`;

const fragmentShaderSource = `
    precision highp float;
    varying vec2 v_texCoord;
    uniform sampler2D u_image;
    uniform sampler2D u_palette;
    uniform sampler2D u_bayerMatrix;
    uniform float u_paletteSize;
    uniform int u_ditherType; // 0: none, 1: bayer/pattern, 2: gradient noise, 3: random, 4: halftone, 5: curly, 6: voronoi, 7: curl, 8: foliage, 9: ripples
    uniform vec2 u_ditherMatrixSize;
    uniform vec2 u_resolution;
    uniform float u_ditherAmount;
    uniform float u_ditherScale;

    float colorDistance(vec3 c1, vec3 c2) {
        vec3 d = c1 - c2;
        return dot(d, d);
    }

    // Interleaved gradient noise
    float interleavedGradientNoise(vec2 n) {
        return fract(52.9829189 * fract(dot(n, vec2(0.06711056, 0.00583715))));
    }

    // A random hash function
    float randomHash(vec2 p)
    {
        p  = fract(p*vec2(5.3983, 5.4427));
        p += dot(p.yx, p.xy+vec2(21.5351, 14.3137));
        return fract(p.x*p.y*95.4337);
    }

    vec2 hash2(vec2 p) {
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return fract(sin(p) * 43758.5453);
    }

    float voronoi(vec2 uv) {
        vec2 cell = floor(uv);
        vec2 frac = fract(uv);

        float min_dist = 1.0;

        for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
                vec2 neighbor_cell = cell + vec2(i, j);
                vec2 point = hash2(neighbor_cell);
                vec2 diff = vec2(i, j) + point - frac;
                float dist = length(diff);
                min_dist = min(min_dist, dist);
            }
        }
        return min_dist;
    }


    // Curly pattern
    float curlyPattern(vec2 pos, vec2 resolution) {
        vec2 uv = pos / resolution.xy;
        float a = atan(uv.y - 0.5, uv.x - 0.5);
        float r = length(uv - 0.5);
        return sin(a * u_ditherScale * 2.0 + r * u_ditherScale * 10.0);
    }

    // Curl noise
    vec3 hash33(vec3 p) {
        p = fract(p * vec3(443.897, 441.423, 437.195));
        p += dot(p, p.yxz + 19.23);
        return fract((p.xxy + p.yzz) * p.zyx);
    }

    float noise(vec3 p) {
        vec3 ip = floor(p);
        vec3 fp = fract(p);
        vec3 u = fp * fp * (3.0 - 2.0 * fp);
        float res = mix(
            mix(mix(dot(hash33(ip + vec3(0,0,0)) - 0.5, fp - vec3(0,0,0)),
                    dot(hash33(ip + vec3(1,0,0)) - 0.5, fp - vec3(1,0,0)), u.x),
                mix(dot(hash33(ip + vec3(0,1,0)) - 0.5, fp - vec3(0,1,0)),
                    dot(hash33(ip + vec3(1,1,0)) - 0.5, fp - vec3(1,1,0)), u.x), u.y),
            mix(mix(dot(hash33(ip + vec3(0,0,1)) - 0.5, fp - vec3(0,0,1)),
                    dot(hash33(ip + vec3(1,0,1)) - 0.5, fp - vec3(1,0,1)), u.x),
                mix(dot(hash33(ip + vec3(0,1,1)) - 0.5, fp - vec3(0,1,1)),
                    dot(hash33(ip + vec3(1,1,1)) - 0.5, fp - vec3(1,1,1)), u.x), u.y), u.z);
        return res;
    }

    float fbm(vec3 p) {
        float sum = 0.0;
        float amp = 1.0;
        float freq = 1.0;
        for (int i = 0; i < 4; i++) {
            sum += noise(p * freq) * amp;
            freq *= 2.0;
            amp *= 0.5;
        }
        return sum;
    }

    vec2 curlNoise(vec3 p) {
        const float EPSILON = 0.001;
        float n1 = fbm(p + vec3(EPSILON, 0.0, 0.0));
        float n2 = fbm(p - vec3(EPSILON, 0.0, 0.0));
        float dx = (n1 - n2) / (2.0 * EPSILON);
        n1 = fbm(p + vec3(0.0, EPSILON, 0.0));
        n2 = fbm(p - vec3(0.0, EPSILON, 0.0));
        float dy = (n1 - n2) / (2.0 * EPSILON);
        return vec2(dy, -dx);
    }

    // Foliage pattern
    float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
    }

    float foliage_noise (vec2 st) {
        vec2 i = floor(st);
        vec2 f = fract(st);
        float a = random(i);
        float b = random(i + vec2(1.0, 0.0));
        float c = random(i + vec2(0.0, 1.0));
        float d = random(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    float foliage_fbm (vec2 st) {
        float value = 0.0;
        float amplitude = 0.5;
        float frequency = 0.0;
        for (int i = 0; i < 5; i++) {
            value += amplitude * foliage_noise(st * frequency * u_ditherScale);
            st *= 2.0;
            amplitude *= 0.5;
            frequency = frequency == 0.0 ? 1.0 : frequency;
        }
        return value;
    }

    // Water ripples pattern
    float ripples(vec2 st) {
        vec2 center = vec2(0.5, 0.5);
        float dist = distance(st, center);
        float ripple = sin(dist * u_ditherScale * 10.0) * 0.05 + 0.5;
        float ripple2 = sin(dist * u_ditherScale * 6.0 + 2.0) * 0.03 + 0.5;
        return (ripple + ripple2) * 0.5;
    }


    void main() {
        vec4 originalColor = texture2D(u_image, v_texCoord);
        vec3 finalColor = originalColor.rgb;

        if (u_ditherType == 1 || u_ditherType == 4) { // Bayer, Halftone or Pattern Dithering
            vec2 ditherCoord = mod(gl_FragCoord.xy, u_ditherMatrixSize) / u_ditherMatrixSize;
            float ditherValue = texture2D(u_bayerMatrix, ditherCoord).r - 0.5;
            finalColor = originalColor.rgb + ditherValue * u_ditherAmount / u_paletteSize;
        } else if (u_ditherType == 2) { // Gradient Noise Dithering
            float noise = interleavedGradientNoise(gl_FragCoord.xy) - 0.5;
            finalColor = originalColor.rgb + noise * u_ditherAmount / u_paletteSize;
        } else if (u_ditherType == 3) { // Random Dithering
            float noise = randomHash(gl_FragCoord.xy) - 0.5;
            finalColor = originalColor.rgb + noise * u_ditherAmount / u_paletteSize;
        } else if (u_ditherType == 5) { // Curly Dithering
            float ditherValue = curlyPattern(gl_FragCoord.xy, u_resolution) * 0.5;
            finalColor = originalColor.rgb + ditherValue * u_ditherAmount / u_paletteSize;
        } else if (u_ditherType == 6) { // Voronoi Dithering
            vec2 uv = gl_FragCoord.xy / u_ditherScale;
            float ditherValue = voronoi(uv) - 0.5;
            finalColor = originalColor.rgb + ditherValue * u_ditherAmount / u_paletteSize;
        } else if (u_ditherType == 7) { // Curl Noise Dithering
            vec3 p = vec3(gl_FragCoord.xy / u_resolution * u_ditherScale, 0.0);
            vec2 c = curlNoise(p);
            float ditherValue = length(c) * 0.5;
            finalColor = originalColor.rgb + ditherValue * u_ditherAmount / u_paletteSize;
        } else if (u_ditherType == 8) { // Foliage Dithering
            vec2 st = gl_FragCoord.xy / u_resolution.xy;
            st.x *= u_resolution.x / u_resolution.y;
            vec2 noise_st = st;
            float ditherValue = foliage_fbm(noise_st);
            finalColor = originalColor.rgb + ditherValue * u_ditherAmount / u_paletteSize;
        } else if (u_ditherType == 9) { // Ripples Dithering
            vec2 st = gl_FragCoord.xy / u_resolution.xy;
            float ditherValue = ripples(st) - 0.5;
            finalColor = originalColor.rgb + ditherValue * u_ditherAmount / u_paletteSize;
        }

        vec3 closestColor = vec3(0.0);
        float minDistance = 1e5;

        for (float i = 0.0; i < 256.0; i++) {
            if (i >= u_paletteSize) break;
            vec3 paletteColor = texture2D(u_palette, vec2( (i + 0.5) / u_paletteSize, 0.5)).rgb;
            float dist = colorDistance(finalColor, paletteColor);
            if (dist < minDistance) {
                minDistance = dist;
                closestColor = paletteColor;
            }
        }

        gl_FragColor = vec4(closestColor, 1.0);
    }
`;

let glCanvas;
let gl;
let vertexShader;
let fragmentShader;
let program;
function prepareShaders(canvas){
    glCanvas = document.createElement('canvas');
    glCanvas.width = canvas.width;
    glCanvas.height = canvas.height;

    gl = glCanvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });

    vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    program = createProgram(gl, vertexShader, fragmentShader);
}

function resetShaders(){
    if (gl) {
        if (vertexShader) gl.deleteShader(vertexShader);
        if (fragmentShader) gl.deleteShader(fragmentShader);
        if (program) gl.deleteProgram(program);
        gl = null;
    }
    glCanvas = null;
    vertexShader = null;
    fragmentShader = null;
    program = null;
}

function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Error compiling shader:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Error linking program:', gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    }
    return program;
}

function runWebGLQuantizer(canvas, palette, dither, ditherPatternImage, ditherAmount, ditherScale) {
    let perf = window.performance || {};
    let t0 = perf.now();

    if (!glCanvas) {
        prepareShaders(canvas);
    } else if (glCanvas.width !== canvas.width || glCanvas.height !== canvas.height) {
        glCanvas.width = canvas.width;
        glCanvas.height = canvas.height;
    }

    if (!gl) {
        console.error('WebGL not supported');
        return false;
    }

    const positionAttributeLocation = gl.getAttribLocation(program, 'a_position');
    const imageLocation = gl.getUniformLocation(program, 'u_image');
    const paletteLocation = gl.getUniformLocation(program, 'u_palette');
    const bayerMatrixLocation = gl.getUniformLocation(program, 'u_bayerMatrix');
    const paletteSizeLocation = gl.getUniformLocation(program, 'u_paletteSize');
    const ditherTypeLocation = gl.getUniformLocation(program, 'u_ditherType');
    const ditherMatrixSizeLocation = gl.getUniformLocation(program, 'u_ditherMatrixSize');
    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
    const ditherAmountLocation = gl.getUniformLocation(program, 'u_ditherAmount');
    const ditherScaleLocation = gl.getUniformLocation(program, 'u_ditherScale');

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const imageTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const paletteData = new Uint8Array(palette.length * 4);
    palette.forEach((color, i) => {
        paletteData[i * 4] = color[0];
        paletteData[i * 4 + 1] = color[1];
        paletteData[i * 4 + 2] = color[2];
        paletteData[i * 4 + 3] = 255;
    });

    const paletteTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, paletteTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, palette.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, paletteData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let ditherValue = 0;
    let ditherMatrix = bayerMatrix;
    let ditherMatrixSize = { width: 8.0, height: 8.0 };
    let useCustomPattern = false;

    if (dither === true || dither === 'bayer') {
        ditherValue = 1;
    } else if (dither === 'gradient-noise') {
        ditherValue = 2;
    } else if (dither === 'random') {
        ditherValue = 3;
    } else if (dither === 'halftone') {
        ditherValue = 4;
        ditherMatrix = halftoneMatrix4x4;
        ditherMatrixSize = { width: 4.0, height: 4.0 };
    } else if (dither === 'curly') {
        ditherValue = 5;
    } else if (dither === 'voronoi') {
        ditherValue = 6;
    } else if (dither === 'curl') {
        ditherValue = 7;
    } else if (dither === 'foliage') {
        ditherValue = 8;
    } else if (dither === 'ripples') {
        ditherValue = 9;
    } else if (dither === 'pattern' && ditherPatternImage) {
        ditherValue = 1; // Reuse bayer/matrix dither logic
        useCustomPattern = true;
        ditherMatrixSize = { width: ditherPatternImage.width, height: ditherPatternImage.height };
    }

    const bayerMatrixTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, bayerMatrixTexture);

    if (useCustomPattern) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ditherPatternImage);
    } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, ditherMatrixSize.width, ditherMatrixSize.height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(ditherMatrix.map(x => x * 255)));
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.useProgram(program);
    gl.enableVertexAttribArray(positionAttributeLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);
    gl.uniform1i(imageLocation, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, paletteTexture);
    gl.uniform1i(paletteLocation, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, bayerMatrixTexture);
    gl.uniform1i(bayerMatrixLocation, 2);

    gl.uniform1f(paletteSizeLocation, palette.length);
    gl.uniform1i(ditherTypeLocation, ditherValue);
    gl.uniform2f(ditherMatrixSizeLocation, ditherMatrixSize.width, ditherMatrixSize.height);
    gl.uniform2f(resolutionLocation, gl.canvas.width, gl.canvas.height);
    gl.uniform1f(ditherAmountLocation, ditherAmount);
    gl.uniform1f(ditherScaleLocation, ditherScale);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const ctx = canvas.getContext('2d');
    ctx.drawImage(glCanvas, 0, 0);

    let t1 = perf.now();
    console.log("WebGL quantization took " + (t1 - t0) + " milliseconds.");
    return true;
}

export { runWebGLQuantizer, resetShaders };