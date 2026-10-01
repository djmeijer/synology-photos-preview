import axios, { type AxiosInstance } from 'axios';
import http from 'node:http';
import https from 'node:https';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, DownloadReservationError, NasError } from './errors.ts';
import { mediaDateLookupBatchSize, type Connection, type ConversionBatch, type MediaItem, type SkippedMedia, type Space } from '../shared/types.ts';

type ApiInfo = { path: string; minVersion: number; maxVersion: number };
type ApiResponse = { success: boolean; error?: { code: number }; data: any };
export type Request = (api: string, method: string, params?: Record<string, string>, signal?: AbortSignal) => Promise<any>;
const API = (space: Space, suffix: string) => `SYNO.${space === 'personal' ? 'Foto' : 'FotoTeam'}.${suffix}`;
const transientCodes = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH']);
function normalizeTakenAt(raw: any): string | undefined {
  const rawTime = raw?.time ?? raw?.taken_time ?? raw?.indexed_time;
  const numericTime = Number(rawTime);
  const timestamp = Number.isFinite(numericTime) && numericTime > 0
    ? numericTime < 100_000_000_000 ? numericTime * 1000 : numericTime
    : typeof rawTime === 'string' ? Date.parse(rawTime) : NaN;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
export async function retry<T>(operation: () => Promise<T>, signal?: AbortSignal, wait = (ms: number) => delay(ms, undefined, { signal })): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      signal?.throwIfAborted();
      const e = error as { code?: string; response?: { status: number; headers?: Record<string, string> } };
      const status = e.response?.status;
      if (attempt >= 3 || (!(status && ([408, 425, 429].includes(status) || status >= 500)) && !transientCodes.has(e.code ?? ''))) throw error;
      const header = e.response?.headers?.['retry-after'];
      const requested = header ? (Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0;
      await wait(Math.max(Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random() * 0.5), Math.min(120_000, requested || 0)));
    }
  }
}
export function normalizeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('Enter a complete NAS address, such as https://nas.example.com:5001.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new AppError('Use the NAS base HTTP(S) address without credentials, a path, or query parameters.');
  return url.origin;
}
export function normalizeItem(raw: any, space: Space): MediaItem {
  const rawId = raw?.unit_id;
  const unitId = typeof rawId === 'number' || (typeof rawId === 'string' && /^\d+$/.test(rawId)) ? Number(rawId) : NaN;
  if (!Number.isSafeInteger(unitId) || unitId < 0 || typeof raw?.filename !== 'string') throw new AppError('NAS returned an unrecognized queue item.', 409, 'COMPATIBILITY');
  const component = raw.type === 'live_video' || raw.is_live_video === true ? 'live_video'
    : raw.type === 0 || raw.type === 'photo' ? 'photo'
    : raw.type === 1 || raw.type === 'video' ? 'video' : null;
  // Numeric types other than the repo's known 0/1 are deliberately not guessed.
  if (!component) throw new AppError(`Unsupported NAS media type for ${raw.filename}.`, 409, 'COMPATIBILITY');
  const flag = (v: unknown) => v === true || v === 1 || v === '1';
  const needThumbnail = raw.need_thumbnail == null ? component === 'photo' : flag(raw.need_thumbnail);
  const needVideo = flag(raw.need_video);
  if (component === 'photo' && needVideo) throw new AppError('NAS returned video work for a photo component.', 409, 'COMPATIBILITY');
  const size = Number(raw.filesize ?? raw.size);
  const takenAt = normalizeTakenAt(raw);
  return { key: `${space}:${unitId}:${component}`, space, unitId, component, filename: raw.filename,
    needThumbnail, needVideo, ...(Number.isFinite(size) && size > 0 ? { size } : {}), ...(takenAt ? { takenAt } : {}) };
}

/** Fetch the work offered now; this endpoint may ignore pagination parameters. */
export async function fetchConversionBatch(request: Request, space: Space, signal?: AbortSignal, knownKeys: ReadonlySet<string> = new Set()): Promise<ConversionBatch> {
  signal?.throwIfAborted();
  const data = await request(API(space, 'Upload.ConvertedFile'), 'list_convert_needed', {
    type: JSON.stringify(['photo', 'video', 'live_video']), preset: 'windows', limit: '500'
  }, signal);
  if (!Array.isArray(data?.list)) throw new AppError('NAS conversion queue response is unsupported.', 409, 'COMPATIBILITY');
  const items = new Map<string, MediaItem>();
  const skipped = new Map<string, SkippedMedia>();
  for (const raw of data.list) {
    const item = normalizeItem(raw, space);
    if (item.component === 'live_video') {
      skipped.set(item.key, { key: item.key, space, unitId: item.unitId, filename: item.filename,
        reason: 'Separate Live Photo video components have no verified download/upload contract.' });
      continue;
    }
    items.set(item.key, item);
  }
  const needed = [...items.values()].filter(item => item.needThumbnail || item.needVideo);
  const knownPending = needed.filter(item => knownKeys.has(item.key));
  const pending = needed.filter(item => !knownKeys.has(item.key));
  const missingDates = pending.filter(item => !item.takenAt);
  for (let offset = 0; offset < missingDates.length; offset += mediaDateLookupBatchSize) {
    const lookup = missingDates.slice(offset, offset + mediaDateLookupBatchSize);
    try {
      const details = await request(API(space, 'Browse.Item'), 'get', {
        id: JSON.stringify(lookup.map(item => item.unitId))
      }, signal);
      const byId = new Map((Array.isArray(details?.list) ? details.list : []).map((raw: any) => [Number(raw.id ?? raw.unit_id), raw]));
      for (const item of lookup) {
        const takenAt = normalizeTakenAt(byId.get(item.unitId));
        if (takenAt) item.takenAt = takenAt;
      }
    } catch { signal?.throwIfAborted(); /* Optional dates must never block conversion. */ }
  }
  signal?.throwIfAborted();
  return { items: pending, skipped: [...skipped.values()], ...(knownPending.length ? { knownPending } : {}) };
}

export class NasClient {
  private client: AxiosInstance;
  private catalog: Record<string, ApiInfo> = {};
  private sid = '';
  private did = '';
  private token = '';
  readonly connection: Connection;
  constructor(url: string, username: string) {
    this.connection = { connected: false, url: normalizeUrl(url), username, spaces: [] };
    this.client = axios.create({ baseURL: this.connection.url, timeout: 30_000, maxRedirects: 0,
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 24 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 24 }) });
  }
  private headers() { return { 'X-Syno-Token': this.token, Cookie: `did=${this.did}; id=${this.sid}` }; }
  private apiDetails(api: string): ApiInfo {
    const info = this.catalog[api];
    if (!info || !/^[\w./-]+\.cgi$/.test(info.path) || info.path.startsWith('/') || info.path.includes('..')) throw new AppError(`NAS does not advertise a usable ${api} endpoint.`, 409, 'COMPATIBILITY');
    return info;
  }
  async login(password: string, otp = ''): Promise<void> {
    const discovery = await this.client.post<ApiResponse>('/webapi/query.cgi', new URLSearchParams({ api: 'SYNO.API.Info', version: '1', method: 'query', query: 'all' }));
    if (!discovery.data.success) throw new NasError(discovery.data.error?.code ?? 0, 'API discovery');
    this.catalog = discovery.data.data;
    const authInfo = this.apiDetails('SYNO.API.Auth');
    const authVersion = Math.min(7, authInfo.maxVersion);
    if (authVersion < authInfo.minVersion || authVersion < 6) throw new AppError('NAS does not advertise a supported token-based authentication API.', 409, 'COMPATIBILITY');
    const auth = await this.client.post<ApiResponse>(`/webapi/${authInfo.path}`, new URLSearchParams({
      api: 'SYNO.API.Auth', method: 'login', version: String(authVersion), account: this.connection.username!, passwd: password,
      otp_code: otp, format: 'sid', enable_syno_token: 'yes', enable_device_token: 'yes', device_name: 'SynologyPreviewDesktop'
    }));
    if (!auth.data.success) throw new NasError(auth.data.error?.code ?? 0, 'login');
    const data = auth.data.data;
    if (!data?.sid || !data?.synotoken) throw new AppError('NAS login response lacks a session or security token.', 409, 'COMPATIBILITY');
    const did = data.device_id ?? data.did ?? '';
    if ([data.sid, data.synotoken, did].some(value => typeof value !== 'string' || /[\r\n;]/.test(value))) throw new AppError('NAS returned invalid session tokens.', 409, 'COMPATIBILITY');
    this.sid = data.sid; this.did = did; this.token = data.synotoken;
    try {
      const info = await this.client.post<ApiResponse>('/webapi/query.cgi', new URLSearchParams({ api: 'SYNO.API.Info', version: '1', method: 'query', query: 'all' }), { headers: this.headers() });
      if (!info.data.success) throw new NasError(info.data.error?.code ?? 0, 'API discovery');
      this.catalog = info.data.data;
      for (const space of ['personal', 'shared'] as Space[]) {
        const converted = this.catalog[API(space, 'Upload.ConvertedFile')];
        const download = this.catalog[API(space, 'Download')];
        if (converted && converted.minVersion <= 3 && converted.maxVersion >= 3 && download && download.minVersion <= 1 && download.maxVersion >= 1) this.connection.spaces.push(space);
      }
      if (!this.connection.spaces.length) throw new AppError('NAS does not advertise supported Photos conversion and download APIs.', 409, 'COMPATIBILITY');
      if (!this.connection.spaces.includes('shared')) this.connection.sharedReason = 'NAS does not advertise a separate Shared Space conversion API. Shared routing must be verified for this Photos version.';
      this.connection.connected = true;
    } catch (error) { await this.logout(); throw error; }
  }
  request: Request = async (api, method, params = {}, signal) => {
    const info = this.apiDetails(api);
    const response = await retry(() => this.client.post<ApiResponse>(`/webapi/${info.path}`, new URLSearchParams({
      api, version: api.endsWith('Upload.ConvertedFile') ? '3' : '1', method, ...params
    }), { headers: this.headers(), signal }), signal);
    if (!response.data.success) throw new NasError(response.data.error?.code ?? 0, method);
    return response.data.data;
  };
  async download(item: MediaItem, destination: string, signal: AbortSignal, maxBytes: number, progress: (percent: number | null, bytes?: number) => void) {
    const info = this.apiDetails(API(item.space, 'Download'));
    await retry(async () => {
      progress(0, 0);
      await rm(destination, { force: true });
      const response = await this.client.get(`/webapi/${info.path}`, { params: {
        api: API(item.space, 'Download'), version: '1', method: 'download', unit_id: JSON.stringify([item.unitId])
      }, headers: this.headers(), responseType: 'stream', timeout: 30 * 60_000, signal });
      if (String(response.headers['content-type']).includes('json')) {
        response.data.destroy();
        throw new AppError('NAS returned an API error instead of original media. Reconnect and check download permissions.', 409);
      }
      const rawLength = Number(response.headers['content-length']);
      const length = Number.isSafeInteger(rawLength) && rawLength > 0 ? rawLength : 0;
      if (length > maxBytes) {
        response.data.destroy();
        throw new DownloadReservationError(length);
      }
      let bytes = 0;
      const counter = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > maxBytes) return done(new DownloadReservationError(bytes, true));
        progress(length > 0 ? Math.min(100, bytes / length * 100) : null, bytes);
        done(null, chunk);
      } });
      await pipeline(response.data, counter, createWriteStream(destination), { signal });
      if (!bytes || (length > 0 && bytes !== length)) throw Object.assign(new Error('Truncated media download'), { code: 'ECONNRESET' });
    }, signal);
  }
  async upload(item: MediaItem, outputs: Record<string, string>, signal: AbortSignal, progress: (percent: number | null, bytes?: number) => void) {
    if (!Object.keys(outputs).length) throw new AppError('Conversion produced no previews.', 409);
    const api = API(item.space, 'Upload.ConvertedFile');
    const info = this.apiDetails(api);
    await retry(async () => {
      progress(0, 0);
      const streams = Object.fromEntries(Object.entries(outputs).map(([key, filename]) => [key, createReadStream(filename)]));
      try {
        const response = await this.client.postForm<ApiResponse>(`/webapi/${info.path}`, {
          api, version: '3', method: 'upload', unit_id: item.unitId, ...streams
        }, { headers: this.headers(), signal, timeout: 30 * 60_000, maxBodyLength: Infinity, maxContentLength: 1024 * 1024,
          onUploadProgress: e => progress(e.total ? e.loaded / e.total * 100 : null, e.loaded) });
        if (!response.data.success) throw new NasError(response.data.error?.code ?? 0, 'preview upload');
      } finally { Object.values(streams).forEach(stream => stream.destroy()); }
    }, signal);
  }
  async logout() {
    if (this.sid) {
      try { const auth = this.apiDetails('SYNO.API.Auth'); await this.client.post(`/webapi/${auth.path}`, new URLSearchParams({ api: 'SYNO.API.Auth', version: String(Math.min(7, auth.maxVersion)), method: 'logout', _sid: this.sid }), { headers: this.headers(), timeout: 5000 }); } catch { /* Always erase the local session. */ }
    }
    this.sid = ''; this.did = ''; this.token = ''; this.connection.connected = false;
  }
}
