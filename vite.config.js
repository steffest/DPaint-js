import { resolve } from 'path'
import { defineConfig } from 'vite'
import fs from 'fs';

const copyWorkersPlugin = () => {
    return {
        name: 'copy-workers',
        apply: 'build',
        writeBundle() {
            fs.cpSync(resolve('./_script/workers'), resolve('./dist/workers'), { recursive: true });
        }
    };
};

export default defineConfig({
    base: "./",
    plugins: [copyWorkersPlugin()],
    build: {
        outDir: './dist',
        assetsDir: '',
    }
})