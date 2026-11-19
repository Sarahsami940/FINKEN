// Bundles the API for production. Third-party packages stay external and are
// installed with npm; the shared money rules are compiled into the bundle.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server.ts', 'src/migrate.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  packages: 'external',
  alias: { '@finken/domain': '../../packages/domain/src' },
  logLevel: 'info',
});
