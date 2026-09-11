import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });
mkdirSync('public', { recursive: true });

/** @type {import('esbuild').BuildOptions[]} */
const configs = [
  {
    entryPoints: ['src/server/index.ts'],
    outfile: 'dist/server.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['ws'],
    sourcemap: true,
    logLevel: 'warning'
  },
  {
    entryPoints: ['src/client/main.ts'],
    outfile: 'public/bundle.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    minify: !watch,
    sourcemap: true,
    logLevel: 'warning'
  },
  {
    entryPoints: ['src/sim/expandtest.ts'],
    outfile: 'dist/expandtest.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'warning'
  },
  {
    entryPoints: ['src/sim/simtest.ts'],
    outfile: 'dist/simtest.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'warning'
  }
];

if (watch) {
  for (const cfg of configs) {
    const ctx = await esbuild.context(cfg);
    await ctx.watch();
  }
  console.log('[build] watching...');
} else {
  for (const cfg of configs) await esbuild.build(cfg);
  console.log('[build] ok');
}
