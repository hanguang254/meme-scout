import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const api = spawn(process.execPath, ['scanner/server.mjs'], {
  cwd,
  stdio: 'inherit',
});
const web = spawn(
  process.execPath,
  [
    'node_modules/vinext/dist/cli.js',
    'dev',
    '--host',
    '127.0.0.1',
    '--port',
    '3000',
  ],
  { cwd, stdio: 'inherit' },
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  api.kill('SIGTERM');
  web.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
api.on('exit', (c) => stop(c || 0));
web.on('exit', (c) => stop(c || 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
