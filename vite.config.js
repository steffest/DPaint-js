import { resolve } from 'path'
import { defineConfig } from 'vite'
import fs from 'fs';

const copyStaticPlugin = () => {
    return {
        name: 'copy-workers',
        apply: 'build',
        writeBundle() {
            //fs.cpSync(resolve('./_script/workers'), resolve('./dist/workers'), { recursive: true });
        }
    };
};

export default defineConfig({
    base: "./",
    plugins: [copyStaticPlugin()],
    // The filter worker (workers/filter.js) imports Effects, which dynamically imports its
    // pixel fallback. Code-splitting a worker is only allowed with the ES module output format.
    worker: {
        format: 'es',
    },
    build: {
        outDir: './dist',
        assetsDir: '',
    }
})