// Minimal build configuration based on obsidianmd/obsidian-sample-plugin (0-BSD).
import * as esbuild from 'esbuild';
const context = await esbuild.context({
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian', 'electron'],
  format: 'cjs', platform: 'browser', target: 'es2022', outfile: 'main.js',
  sourcemap: false, logLevel: 'info'
});
if (process.argv.includes('--watch')) await context.watch();
else { await context.rebuild(); await context.dispose(); }
