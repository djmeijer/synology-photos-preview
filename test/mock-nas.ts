import type test from 'node:test';
import http from 'node:http';
import { NasClient } from '../server/nas.ts';
const raw = (id: number) => ({ unit_id: id, filename: 'media-' + id + '.heic', type: 0, need_thumbnail: true, time: 1_609_459_200 + id * 86_400 });
export async function mockNas(t: test.TestContext, options: { otp?: boolean; denyShared?: boolean; rejectUpload?: boolean; transientDownload?: boolean; advertisedShared?: boolean; authMax?: number; listOnlyQueue?: boolean; queueBatches?: number[][]; deviceToken?: unknown; partialDownload?: boolean; persistentPartialDownload?: boolean; transientUpload?: boolean; queueList?: unknown[]; chunkedDownload?: boolean; uploadCodes?: number[] } = {}) {
  const requests: { api: string; method: string; params: URLSearchParams; cookie: string; body: string }[] = [];
  let downloads = 0, uploads = 0, queueRequest = 0;
  const catalog = Object.fromEntries(['SYNO.API.Auth', 'SYNO.Foto.Upload.ConvertedFile', 'SYNO.Foto.Download', ...(options.advertisedShared === false ? [] : ['SYNO.FotoTeam.Upload.ConvertedFile', 'SYNO.FotoTeam.Download'])].map(api => [api, { path: 'entry.cgi', minVersion: 1, maxVersion: api === 'SYNO.API.Auth' ? options.authMax ?? 7 : api.endsWith('ConvertedFile') ? 3 : 1 }]));
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, 'http://localhost');
    const params = req.method === 'GET' ? url.searchParams : new URLSearchParams(body);
    // Extract multipart fields for upload routing assertions.
    const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]+)`).exec(body)?.[1];
    const api = params.get('api') ?? field('api') ?? '', method = params.get('method') ?? field('method') ?? '';
    requests.push({ api, method, params, body, cookie: req.headers.cookie ?? '' });
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (api === 'SYNO.API.Info') return json({ success: true, data: catalog });
    if (api === 'SYNO.API.Auth' && method === 'logout') return json({ success: true, data: {} });
    if (api === 'SYNO.API.Auth') {
      if (params.get('passwd') !== 'secret') return json({ success: false, error: { code: 400 } });
      if (options.otp && params.get('otp_code') !== '123456') return json({ success: false, error: { code: 403 } });
      return json({ success: true, data: { sid: 'session-secret', synotoken: 'token-secret', did: options.deviceToken ?? 'device-secret' } });
    }
    if (options.denyShared && api.startsWith('SYNO.FotoTeam.')) return json({ success: false, error: { code: 105 } });
    if (method === 'list_convert_needed') return json({ success: true, data: options.queueList ? { list: options.queueList } : options.queueBatches
      ? { list: (options.queueBatches[queueRequest++] ?? []).map(raw) }
      : options.listOnlyQueue ? { list: [raw(1)] }
      : { total: 1, list: [raw(1)] } });
    if (method === 'download') {
      downloads++;
      if (options.transientDownload && downloads === 1) { res.writeHead(503); return res.end('retry'); }
      if (options.persistentPartialDownload || (options.partialDownload && downloads === 1)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': '14' }); res.write('first');
        setTimeout(() => res.destroy(), 30); return;
      }
      res.setHeader('Content-Type', 'image/jpeg');
      if (options.chunkedDownload) res.flushHeaders();
      res.end('original-bytes'); return;
    }
    if (method === 'upload') {
      const attempt = uploads++;
      const code = options.uploadCodes?.[attempt];
      if (options.transientUpload && uploads === 1) { res.writeHead(503); return res.end('retry'); }
      if (code) return json({ success: false, error: { code } });
      return json(options.rejectUpload ? { success: false, error: { code: 105 } } : { success: true, data: {} });
    }
    json({ success: false, error: { code: 102 } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address() as { port: number };
  return { client: new NasClient(`http://127.0.0.1:${address.port}`, 'test-user'), requests, url: `http://127.0.0.1:${address.port}` };
}
