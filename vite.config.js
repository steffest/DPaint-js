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
    build: {
        outDir: './dist',
        assetsDir: '',
    }
})