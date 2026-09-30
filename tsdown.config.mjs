import { defineConfig } from 'tsdown'

const ID = 'dsh-jev-ultrafast'
// The browser half runs inside the Web UI's own React; bundling a second copy
// would break hooks. The module loader supplies it as `require('react')`.
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime']

export default defineConfig([
  {
    // The node half: tsdown bundles src/index.ts into lib/index.js (ESM) and emits
    // lib/index.d.ts. It is also the self-contained `prepare` script for git
    // installs: no project references, no type checking (see guide §7.1
    // "build-script catch").
    name: ID,
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    dts: true,
    clean: true,
    sourcemap: false,
    outDir: 'lib',
  },
  {
    // The browser half: a lazy CommonJS factory the Web UI's module loader calls
    // with its own `require`. The banner/footer/intro below are the whole format —
    // `id` must stay the bare package name in quotes, and `minify` must stay off,
    // or the startup guard's registration check stops matching and the plugin is
    // disabled without a word. `scripts/check-client-id.mjs` enforces both.
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: false,
    minify: false,
    deps: {
      neverBundle: CLIENT_EXTERNALS,
      alwaysBundle: (id) => !CLIENT_EXTERNALS.includes(id),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      codeSplitting: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
