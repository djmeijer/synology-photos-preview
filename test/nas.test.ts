import test from 'node:test';
import assert from 'node:assert/strict';
import { mockNas } from './mock-nas.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchConversionBatch, NasClient, normalizeItem, normalizeUrl, retry } from '../server/nas.ts';
import { NasError } from '../server/errors.ts';

const raw = (id: number, type: number | string = 0) => ({ unit_id: id, filename: `media-${id}.heic`, type, need_thumbnail: true, need_video: type === 1 });
test('fetches one batch without requiring totals, offsets or pagination', async () => {
  let calls = 0;
  const items = await fetchConversionBatch(async (api, method, params) => {
    calls++;
    if (api.endsWith('Browse.Item')) {
      assert.equal(method, 'get');
      assert.deepEqual(JSON.parse(params!.id), Array.from({ length: 217 }, (_, i) => i));
      return { list: Array.from({ length: 217 }, (_, i) => ({ id: i, time: 1_609_459_200 + i * 86_400 })) };
    }
    assert.equal(api, 'SYNO.Foto.Upload.ConvertedFile');
    assert.equal(method, 'list_convert_needed');
    assert.equal(params!.offset, undefined);
    return { list: Array.from({ length: 217 }, (_, i) => raw(i)) };
  }, 'personal');
  assert.equal(calls, 2);
  assert.equal(items.length, 217);
  assert.equal(items[0].takenAt, '2021-01-01T00:00:00.000Z');
  assert.equal(items.at(-1)?.takenAt, '2021-08-05T00:00:00.000Z');
});
test('deduplicates batch identities and filters completed work', async () => {
  const items = await fetchConversionBatch(async () => ({ list: [raw(1), raw(1), { ...raw(2), need_thumbnail: false }, raw(3, 1)] }), 'shared');
  assert.deepEqual(items.map(item => item.key), ['shared:1:photo', 'shared:3:video']);
  assert.deepEqual(await fetchConversionBatch(async () => ({ list: [] }), 'personal'), []);
});
test('rejects malformed batches and unsupported media and respects cancellation', async () => {
  await assert.rejects(fetchConversionBatch(async () => ({}), 'personal'), /unsupported/);
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(fetchConversionBatch(async () => { calls++; return { list: [] }; }, 'personal', controller.signal));
  assert.equal(calls, 0);
  assert.throws(() => normalizeItem(raw(1, 2), 'personal'), /Unsupported/);
  assert.throws(() => normalizeItem(raw(1, 'live_video'), 'personal'), /Live Photo/);
});
test('same unit ID stays distinct by space and component', () => {
  assert.notEqual(normalizeItem(raw(1), 'personal').key, normalizeItem(raw(1), 'shared').key);
  assert.notEqual(normalizeItem(raw(1), 'personal').key, normalizeItem(raw(1, 1), 'personal').key);
  assert.throws(() => normalizeUrl('https://user:password@nas.example'), /without credentials/);
  assert.equal(normalizeItem({ ...raw(2), time: 1_609_459_200 }, 'personal').takenAt, '2021-01-01T00:00:00.000Z');
  assert.equal(normalizeItem({ ...raw(3), indexed_time: 1_640_995_200_000 }, 'personal').takenAt, '2022-01-01T00:00:00.000Z');
});
test('transient HTTP failures retry; permission failures and cancellation do not', async () => {
  let calls = 0;
  assert.equal(await retry(async () => { if (++calls < 3) throw { response: { status: 503 } }; return 'ok'; }, undefined, async () => {}), 'ok');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new NasError(105, 'scan'); }, undefined, async () => {}));
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(retry(async () => { calls++; }, controller.signal)); assert.equal(calls, 1);
});

test('discovery, wrong password, OTP and shared permission errors', async t => {
  const { client, requests } = await mockNas(t, { otp: true, denyShared: true, authMax: 6 });
  await assert.rejects(client.login('wrong'), /Incorrect/);
  await assert.rejects(client.login('secret'), /Two-factor/);
  await client.login('secret', '123456');
  assert.equal(client.connection.connected, true);
  assert.equal(requests.find(r => r.method === 'login')!.params.get('version'), '6');
  await assert.rejects(fetchConversionBatch(client.request, 'shared'), /access denied/);
  await client.logout(); assert.equal(client.connection.connected, false);
});
test('streams downloads and multipart uploads using distinct Personal and Shared routes', async t => {
  const { client, requests } = await mockNas(t, { transientDownload: true }); await client.login('secret');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-nas-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const space of ['personal', 'shared'] as const) {
    const item = normalizeItem(raw(1), space), source = path.join(directory, `${space}.jpg`);
    await client.download(item, source, new AbortController().signal, 1024, () => {});
    assert.equal(await readFile(source, 'utf8'), 'original-bytes');
    await writeFile(source, 'preview-bytes'); await client.upload(item, { thumb_sm: source }, new AbortController().signal, () => {});
    assert.equal(requests.at(-1)!.api, `SYNO.${space === 'personal' ? 'Foto' : 'FotoTeam'}.Upload.ConvertedFile`);
    assert.match(requests.at(-1)!.body, /preview-bytes/);
    assert.match(requests.at(-1)!.cookie, /id=session-secret/);
  }
  assert.equal(JSON.stringify(client.connection).includes('secret'), false);
  await client.logout();
});
test('API upload acknowledgment is required and missing Shared APIs are explicit', async t => {
  const { client } = await mockNas(t, { rejectUpload: true, advertisedShared: false }); await client.login('secret');
  assert.deepEqual(client.connection.spaces, ['personal']); assert.match(client.connection.sharedReason!, /Shared/);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-upload-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'preview.jpg'); await writeFile(output, 'jpeg');
  await assert.rejects(client.upload(normalizeItem(raw(1), 'personal'), { thumb_sm: output }, new AbortController().signal, () => {}), /access denied/);
  await client.logout();
});
