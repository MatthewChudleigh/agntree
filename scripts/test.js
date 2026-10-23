// Builds the unit tests in src/test/*.test.ts with esbuild and runs them with Node's
// built-in test runner. Extra arguments are passed to `node --test`.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'src', 'test');
const outDir = path.join(root, 'out-test');

const entryPoints = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => path.join(testDir, file));

// Scripts that tests run as separate processes; built to out-test/fixtures/.
const fixtureDir = path.join(testDir, 'fixtures');
const fixtures = fs.existsSync(fixtureDir)
  ? fs.readdirSync(fixtureDir).filter((file) => file.endsWith('.ts')).map((file) => path.join(fixtureDir, file))
  : [];

fs.rmSync(outDir, { recursive: true, force: true });
esbuild.buildSync({
  entryPoints: [...entryPoints, ...fixtures],
  outbase: testDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outdir: outDir,
  // Code under test must not depend on the VS Code API; this makes any such import fail loudly.
  external: ['vscode'],
  sourcemap: 'inline',
  logLevel: 'warning',
});

const files = entryPoints.map((entry) => path.join(outDir, `${path.basename(entry, '.ts')}.js`));
const result = spawnSync(process.execPath, ['--enable-source-maps', '--test', ...process.argv.slice(2), ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
