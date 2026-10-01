import path from 'node:path';
import { access } from 'node:fs/promises';
import { createApp, projectDirectory, Studio } from './app.ts';

const port = Number(process.env.APP_PORT ?? 4177);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('APP_PORT must be an integer between 1024 and 65535.');
try { await access(path.join(projectDirectory, 'dist', 'index.html')); }
catch { console.error('Build the interface first: npm run build'); process.exit(1); }
const studio = new Studio(path.resolve(process.env.APP_DATA_DIRECTORY || path.join(projectDirectory, '.data')));
await studio.initialize();
const server = createApp(studio, port).listen(port, '127.0.0.1', () => {
  console.log(`Synology Preview Studio: http://127.0.0.1:${port}`);
  studio.hardware?.warnings.forEach(warning => console.log(warning));
});
server.on('error', error => { console.error(`Cannot start the local web interface: ${(error as NodeJS.ErrnoException).code}`); process.exitCode = 1; });
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  server.close(); server.closeAllConnections();
  await studio.shutdown(); process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
