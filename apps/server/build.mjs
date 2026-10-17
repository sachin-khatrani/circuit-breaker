import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Workspace packages ship TypeScript source, so they are bundled in; real npm
// dependencies stay external and load from node_modules at runtime.
const external = Object.keys(pkg.dependencies ?? {}).filter(
  (name) => !name.startsWith('@circuit-breaker/'),
);

await build({
  absWorkingDir: root,
  // The game server, and the database chores it shares its config with.
  entryPoints: ['src/index.ts', 'src/dbcli.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  // The built server defaults to production unless NODE_ENV is set explicitly.
  banner: { js: 'process.env.NODE_ENV ??= "production";' },
  logLevel: 'info',
});
