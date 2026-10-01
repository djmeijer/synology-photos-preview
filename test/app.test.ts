import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { Studio, createApp, validateJobInput } from '../server/app.ts';
import { mockNas } from './mock-nas.ts';
import { MediaConverter } from '../server/media.ts';
import { command } from '../server/process.ts';
import { validateSettings, writeJson } from '../server/settings.ts';
import { AppError } from '../server/errors.ts';
import type { Hardware } from '../shared/types.ts';

const hardware: Hardware = { cpu: 'test', logicalCpus: 8, memoryGiB: 32, gpu: null, ffmpeg: true, ffprobe: true, magick: true, heic: true, nvenc: false, cudaScale: false, hdrFilters: true, warnings: [] };
async function studioFixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-app-test-'));
  const studio = new Studio(directory, { refillIntervalMs: 10 }); studio.hardware = hardware;
  t.after(async () => { await studio.shutdown(); await rm(directory, { recursive: true, force: true }); });
  return studio;
}
test('local API requires loopback Host and a same-origin CSRF token; SSE supplies the current job on reconnection', async t => {
  const studio = await studioFixture(t), server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  server.on('request', createApp(studio, port));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const response = await fetch(`${base}/api/state`), state = await response.json() as any;
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/api/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Preview-Token': state.csrfToken, Origin: 'https://foreign.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Preview-Token': state.csrfToken }, body: '{}' })).status, 200);
  for (const body of ['{invalid', '[]', 'null', '{"retryFailed":"true"}', '{"library":["personal"]}']) {
    const invalid = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Preview-Token': state.csrfToken }, body });
    assert.equal(invalid.status, 400); assert.equal((await invalid.json() as any).code, 'APP_ERROR');
  }
  const hostile = await new Promise<number>(resolve => { http.get(`${base}/api/state`, { headers: { Host: 'foreign.example' } }, res => { res.resume(); resolve(res.statusCode!); }); });
  assert.equal(hostile, 403);
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController(), events = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = events.body!.getReader(), data = new TextDecoder().decode((await reader.read()).value);
    assert.match(data, /data: /); assert.match(data, /"connected":false/); assert.equal(data.includes('csrfToken'), false);
    controller.abort(); await reader.cancel().catch(() => {});
  }
});
test('direct execution handles unpaginated batches, job conflicts, cleanup and retries without exposing credentials', async t => {
  const studio = await studioFixture(t), nas = await mockNas(t, { listOnlyQueue: true });
  await studio.connect({ url: nas.url, username: 'test-user', password: 'secret' });
  await assert.rejects(studio.start({ library: 'invalid' as any }), /Invalid library/);
  // Hold conversion after download so job-control conflicts can be exercised deterministically.
  const original = MediaConverter.prototype.convert;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  MediaConverter.prototype.convert = async () => { await hold; throw new AppError('Deliberate conversion failure'); };
  t.after(() => { MediaConverter.prototype.convert = original; });
  await studio.start({ library: 'both' });
  await assert.rejects(studio.start({ library: 'both' }), /current operation/);
  await assert.rejects(studio.disconnect(), /current operation/);
  assert.equal(studio.job!.snapshot().total, 2);
  const batchRequests = nas.requests.filter(r => r.method === 'list_convert_needed');
  assert.equal(batchRequests.length, 2);
  assert.deepEqual(batchRequests.map(r => r.api), ['SYNO.Foto.Upload.ConvertedFile', 'SYNO.FotoTeam.Upload.ConvertedFile']);
  assert.ok(batchRequests.every(r => !r.params.has('offset')));
  assert.equal(JSON.stringify(studio.state()).includes('secret'), false);
  release(); await studio.job!.completion;
  while (studio.finalizing) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(studio.job!.snapshot().success, 0); assert.equal(studio.job!.snapshot().failed, 2);
  assert.ok(nas.requests.filter(r => r.method === 'list_convert_needed').length >= 2);
  assert.equal(studio.history.length, 1);
  const persisted = (await readFile(path.join(studio.dataDirectory, 'settings.json'), 'utf8')) + (await readFile(path.join(studio.dataDirectory, 'history.json'), 'utf8'));
  assert.equal(persisted.includes('secret'), false);
  assert.deepEqual(await readdir(path.join(studio.dataDirectory, 'work')), []);
  // Retry starts with retained failures and then checks the NAS for additional work.
  const firstId = studio.job!.id;
  await studio.start({ retryFailed: true }); await studio.job!.completion;
  while (studio.finalizing) await new Promise(resolve => setTimeout(resolve, 5));
  assert.notEqual(studio.job!.id, firstId); assert.equal(studio.job!.snapshot().total, 2);
});
test('successful batches continue automatically until the NAS returns no new work', async t => {
  const studio = await studioFixture(t), nas = await mockNas(t, { queueBatches: [[1], [2], []] });
  await studio.connect({ url: nas.url, username: 'test-user', password: 'secret' });
  const original = MediaConverter.prototype.convert;
  MediaConverter.prototype.convert = async (_item, _source, directory) => {
    const output = path.join(directory, 'preview.jpg'); await writeFile(output, 'preview'); return { thumb_sm: output };
  };
  t.after(() => { MediaConverter.prototype.convert = original; });

  await studio.start({ library: 'personal' });
  const deadline = Date.now() + 5000;
  while (nas.requests.filter(request => request.method === 'list_convert_needed').length < 3 || studio.job?.active || studio.finalizing) {
    if (Date.now() > deadline) assert.fail('Automatic batch processing did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.ok(nas.requests.filter(request => request.method === 'list_convert_needed').length >= 3);
  assert.equal(nas.requests.filter(request => request.method === 'upload').length, 2);
  assert.equal(studio.job!.snapshot().status, 'completed');
  assert.deepEqual(studio.job!.items.map(item => item.unitId), [1, 2]);
  assert.equal(studio.history.filter(run => run.status === 'completed').length, 1);
});

test('a NAS that repeatedly lists an uploaded movie cannot produce a clean completion', async t => {
  const movie = { unit_id: 7, filename: 'recurring.mov', type: 'video', need_thumbnail: false, need_video: true, time: 1_609_459_200 };
  const studio = await studioFixture(t), nas = await mockNas(t, { queueList: [movie] });
  await studio.connect({ url: nas.url, username: 'test-user', password: 'secret' });
  const original = MediaConverter.prototype.convert;
  MediaConverter.prototype.convert = async (_item, _source, dir) => {
    const output = path.join(dir, 'film_h264.mp4'); await writeFile(output, 'preview'); return { film_h264: output };
  };
  t.after(() => { MediaConverter.prototype.convert = original; });
  await studio.start({ library: 'personal' }); await studio.job!.completion;
  while (studio.finalizing) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(nas.requests.filter(request => request.method === 'download').length, 1);
  assert.equal(nas.requests.filter(request => request.method === 'upload').length, 1);
  assert.equal(studio.job!.status, 'completed_with_errors');
  assert.equal(studio.job!.snapshot().success, 1);
  assert.match(studio.history[0].warnings![0], /recurring\.mov.*unit 7/);
  const persisted = JSON.parse(await readFile(path.join(studio.dataDirectory, 'history.json'), 'utf8'));
  assert.equal(persisted[0].status, 'completed_with_errors');
  assert.match(persisted[0].warnings[0], /H\.264 video preview/);
});

test('pending inspection reports preview requirements without downloading or uploading', async t => {
  const studio = await studioFixture(t), nas = await mockNas(t, { queueList: [
    { unit_id: 7, filename: 'recurring.mov', type: 'video', need_thumbnail: false, need_video: true }
  ] });
  await assert.rejects(studio.inspectPending('personal'), /Connect to your NAS/);
  await studio.connect({ url: nas.url, username: 'test-user', password: 'secret' });
  const batch = await studio.inspectPending('personal');
  assert.deepEqual(batch.items.map(item => [item.filename, item.unitId, item.needThumbnail, item.needVideo]), [['recurring.mov', 7, false, true]]);
  assert.equal(studio.job, null);
  assert.equal(nas.requests.filter(request => ['download', 'upload'].includes(request.method)).length, 0);
  await assert.rejects(studio.inspectPending('invalid' as any), /Invalid library/);
});
test('restart requires login and preserves an interrupted summary without session tokens', async t => {
  const studio = await studioFixture(t);
  await writeJson(path.join(studio.dataDirectory, 'history.json'), [{ id: 'old', library: 'both', status: 'running', startedAt: new Date().toISOString(), total: 10, success: 4, failed: 1, cancelled: 0, remaining: 5, active: [], errors: [] }]);
  // Tools may be absent; initialization still succeeds and reports readiness warnings.
  await studio.initialize();
  assert.equal(studio.nas, null); assert.equal(studio.job, null);
  assert.equal(studio.history[0].status, 'stopped'); assert.equal(studio.history[0].success, 4); assert.equal(studio.history[0].cancelled, 5);
  assert.match(studio.history[0].verificationError!, /restarted/);
});
test('settings reject credentials, prototype keys and invalid bounds; subprocess cancellation waits for exit', async () => {
  assert.throws(() => validateSettings({ password: 'secret' }), /Unknown setting/);
  assert.throws(() => validateSettings(JSON.parse('{"__proto__":{}}')), /Unknown setting/);
  assert.throws(() => validateSettings({ videos: 9 }), /Invalid/);
  assert.throws(() => validateSettings({ library: ['personal'] }), /Invalid library/);
  const controller = new AbortController();
  const running = command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50); await assert.rejects(running, /cancelled/);
});

test('job request validation accepts only an object with typed options', () => {
  for (const input of [null, undefined, false, 1, 'personal', [], { library: ['personal'] }, { library: null }, { retryFailed: 'true' }, { retryFailed: null }, { extra: true }]) {
    assert.throws(() => validateJobInput(input), AppError);
  }
  assert.deepEqual(validateJobInput({}), {});
  assert.deepEqual(validateJobInput({ library: 'personal', retryFailed: false }), { library: 'personal', retryFailed: false });
});

test('disconnect guards overlapping connection operations until logout completes', async t => {
  const studio = await studioFixture(t), nas = await mockNas(t);
  await studio.connect({ url: nas.url, username: 'test-user', password: 'secret' });
  const client = studio.nas!, original = client.logout.bind(client);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  client.logout = async () => { await held; await original(); };
  const disconnecting = studio.disconnect();
  await assert.rejects(studio.connect({ url: nas.url, username: 'test-user', password: 'secret' }), /current operation/);
  await assert.rejects(studio.disconnect(), /current operation/);
  await assert.rejects(studio.start({ library: 'personal' }), /current operation/);
  release(); await disconnecting; assert.equal(studio.nas, null);
});

test('a normal run persists its selected space for the next session', async t => {
  const studio = await studioFixture(t), nas = await mockNas(t);
  await studio.connect({ url: nas.url, username: 'test-user', password: 'secret' });
  await studio.start({ library: 'personal' }); studio.job!.stop(); await studio.job!.completion;
  assert.equal(studio.settings.library, 'personal');
  const persisted = JSON.parse(await readFile(path.join(studio.dataDirectory, 'settings.json'), 'utf8'));
  assert.equal(persisted.library, 'personal');
});

test('cleanup and persistence warnings survive finalization without losing successes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-finalization-test-'));
  const studio = new Studio(directory, { refillIntervalMs: 5, cleanupRun: async () => { throw new Error('Locked directory'); } });
  studio.hardware = hardware;
  t.after(async () => { await studio.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const nas = await mockNas(t, { queueBatches: [[1], []] });
  await studio.connect({ url: nas.url, username: 'test-user', password: 'secret' });
  // A directory at the history filename makes atomic writes fail on all platforms.
  await mkdir(path.join(directory, 'history.json'));
  const original = MediaConverter.prototype.convert;
  MediaConverter.prototype.convert = async (_item, _source, dir) => {
    const output = path.join(dir, 'preview.jpg'); await writeFile(output, 'preview'); return { thumb_sm: output };
  };
  t.after(() => { MediaConverter.prototype.convert = original; });
  await studio.start({ library: 'personal' }); await studio.job!.completion;
  while (studio.finalizing) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(studio.finalizing, false); assert.equal(studio.job!.snapshot().success, 1);
  assert.equal(studio.job!.status, 'completed_with_errors');
  assert.ok(studio.job!.snapshot().warnings!.some(message => message.includes('save run history')));
  assert.ok(studio.job!.snapshot().warnings!.some(message => message.includes('temporary directory')));
  assert.equal(studio.history[0].status, 'completed_with_errors');
});

test('mixed Live Photo batches process supported files and unsupported-only batches do not launch', async t => {
  const supported = { unit_id: 1, filename: 'regular.jpg', type: 'photo', need_thumbnail: true, time: 1_609_459_200 };
  const unsupported = { unit_id: 2, filename: 'live.mov', type: 'live_video', need_video: true };
  for (const mixed of [false, true]) {
    await t.test(mixed ? 'mixed batch' : 'unsupported only', async t => {
      const studio = await studioFixture(t), nas = await mockNas(t, { queueList: mixed ? [supported, unsupported] : [unsupported] });
      await studio.connect({ url: nas.url, username: 'test-user', password: 'secret' });
      if (!mixed) {
        await assert.rejects(studio.start({ library: 'personal' }), /No supported pending previews/);
        assert.equal(studio.job, null); assert.equal(studio.starting, false);
      } else {
        const original = MediaConverter.prototype.convert;
        MediaConverter.prototype.convert = async (_item, _source, dir) => {
          const output = path.join(dir, 'preview.jpg'); await writeFile(output, 'preview'); return { thumb_sm: output };
        };
        t.after(() => { MediaConverter.prototype.convert = original; });
        await studio.start({ library: 'personal' }); await studio.job!.completion;
        assert.equal(studio.job!.snapshot().success, 1); assert.equal(studio.job!.snapshot().skipped, 1);
        assert.equal(studio.job!.status, 'completed_with_errors');
      }
      const transfers = nas.requests.filter(request => ['download', 'upload'].includes(request.method));
      assert.equal(transfers.length, mixed ? 2 : 0);
      assert.ok(transfers.every(request => request.params.get('unit_id') !== '[2]' && !request.body.includes('name="unit_id"\r\n\r\n2\r\n')));
    });
  }
});
