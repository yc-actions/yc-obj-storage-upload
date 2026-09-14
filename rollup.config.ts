// See: https://rollupjs.org/introduction/

import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

// @yandex-cloud/nodejs-sdk, @grpc/grpc-js, nice-grpc and jsonwebtoken are
// CommonJS and reference require, __filename and __dirname. None of the three
// exist in an ES module, so the bundle defines them from import.meta.url.
const banner = [
    "import { createRequire as __createRequire } from 'node:module'",
    "import { fileURLToPath as __fileURLToPath } from 'node:url'",
    "import { dirname as __pathDirname } from 'node:path'",
    'const require = __createRequire(import.meta.url)',
    'const __filename = __fileURLToPath(import.meta.url)',
    'const __dirname = __pathDirname(__filename)'
].join('\n')

const config = {
    input: 'src/index.ts',
    output: {
        banner,
        esModule: true,
        file: 'dist/index.js',
        format: 'es',
        inlineDynamicImports: true,
        sourcemap: true
    },
    plugins: [
        typescript(),
        // exportConditions: ['node'] is an addition to the template. The AWS SDK
        // and @smithy/* packages publish browser variants; without it, resolve
        // can pick a browser build whose crypto and stream shims do not work on
        // the Actions runner.
        nodeResolve({ preferBuiltins: true, exportConditions: ['node'] }),
        commonjs(),
        json()
    ]
}

export default config
