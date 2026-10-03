import express from 'express';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, errorMessage, NasError } from './errors.ts';
import { defaults, readJson, validateSettings, writeJson } from './settings.ts';
import { fetchConversionBatch, NasClient } from './nas.ts';
import { inspectHardware, MediaConverter } from './media.ts';
import { ConversionJob } from './queue.ts';
import type { AppState, ConversionBatch, Hardware, JobSnapshot, Library, MediaItem, Settings, SkippedMedia, Space } from '../shared/types.ts';

export const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function validateJobInput(input: unknown): { library?: Library; retryFailed?: boolean } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('Job request must be an object.');
  const values = input as Record<string, unknown>;
  if (Object.keys(values).some(key => !['library', 'retryFailed'].includes(key))) throw new AppError('Unknown job request option.');
  if (Object.hasOwn(values, 'library') && (typeof values.library !== 'string' || !['personal', 'shared', 'both'].includes(values.library))) throw new AppError('Invalid library.');
  if (Object.hasOwn(values, 'retryFailed') && typeof values.retryFailed !== 'boolean') throw new AppError('retryFailed must be a boolean.');
  return values as { library?: Library; retryFailed?: boolean };
}
export class Studio extends EventEmitter {
  readonly serverId = randomUUID();
  private revision = 0;
  settings: Settings = { ...defaults };
  hardware: Hardware | null = null;
  nas: NasClient | null = null;
  job: ConversionJob | null = null;
  history: JobSnapshot[] = [];
  starting = false;
  finalizing = false;
  private batchLoop = Promise.resolve();
  private connecting = false;
  private updating = false;
  private shuttingDown = false;
  private persistence = Promise.resolve();
  constructor(readonly dataDirectory: string, private jobOptions: { refillIntervalMs?: number; cleanupRun?: (directory: string) => Promise<void> } = {}) { super(); }
  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    this.settings = validateSettings(await readJson(path.join(this.dataDirectory, 'settings.json'), defaults));
    if (this.settings.magick === 'magick') {
      const portable = path.join(projectDirectory, '.tools', 'imagemagick', 'magick.exe');
      try { await access(portable); this.settings.magick = portable; } catch { /* Use PATH or the configured executable. */ }
    }
    this.history = await readJson(path.join(this.dataDirectory, 'history.json'), []);
    this.history = this.history.map(run => ({ ...run, skipped: run.skipped ?? 0, warnings: run.warnings ?? [], mediaDateActiveCount: run.mediaDateActiveCount ?? 0, mediaDateKnownCount: run.mediaDateKnownCount ?? 0 }));
    this.history = this.history.map(run => ['running', 'paused', 'stopping'].includes(run.status) ? {
      ...run, status: 'stopped', cancelled: run.cancelled + run.remaining, remaining: 0, active: [], settledPercent: 100,
      verificationError: 'The application restarted during this run. Connect and execute again to fetch pending work.'
    } : run);
    this.hardware = await inspectHardware(this.settings);
  }
  state(): AppState {
    return { serverId: this.serverId, revision: this.revision, settings: this.settings, hardware: this.hardware, connection: this.nas?.connection ?? { connected: false, spaces: [] },
      job: this.job?.snapshot() ?? null, history: this.history, starting: this.starting, finalizing: this.finalizing };
  }
  changed() { this.revision++; this.emit('change'); }
  private checkpoint(job: ConversionJob) {
    const snapshot = job.snapshot();
    this.history = [{ ...snapshot, active: [], errors: snapshot.errors.slice(0, 100) }, ...this.history.filter(run => run.id !== job.id)].slice(0, 10);
    const history = this.history;
    this.persistence = this.persistence.then(() => writeJson(path.join(this.dataDirectory, 'history.json'), history)).catch(() => {
      job.addWarning('Could not save run history.');
      const latest = job.snapshot();
      this.history = [{ ...latest, active: [], errors: latest.errors.slice(0, 100) }, ...this.history.filter(run => run.id !== job.id)].slice(0, 10);
      this.changed();
    });
    return this.persistence;
  }
  private ensureIdle() {
    if (this.shuttingDown) throw new AppError('The desktop server is shutting down.', 409);
    if (this.job?.active || this.connecting || this.starting || this.updating || this.finalizing) throw new AppError('Finish or stop the current operation first.', 409);
  }
  async saveSettings(input: unknown) {
    this.ensureIdle(); this.updating = true;
    try {
      const settings = validateSettings(input, this.settings);
      if (this.nas && (settings.nasUrl !== this.settings.nasUrl || settings.username !== this.settings.username)) throw new AppError('Disconnect before changing the NAS address or username.', 409);
      await writeJson(path.join(this.dataDirectory, 'settings.json'), settings);
      this.settings = settings; this.hardware = await inspectHardware(settings); this.changed();
    } finally { this.updating = false; }
  }
  async connect(input: any) {
    this.ensureIdle(); this.connecting = true;
    try {
      if (!input || typeof input.url !== 'string' || typeof input.username !== 'string' || typeof input.password !== 'string' || !input.username || !input.password || (input.otp != null && typeof input.otp !== 'string')) throw new AppError('NAS address, username, and password are required.');
      if (this.nas) await this.nas.logout(); this.nas = null;
      const nas = new NasClient(input.url, input.username);
      await nas.login(input.password, input.otp ?? '');
      this.nas = nas;
      this.settings = { ...this.settings, nasUrl: nas.connection.url!, username: input.username };
      await writeJson(path.join(this.dataDirectory, 'settings.json'), this.settings);
    } finally { this.connecting = false; this.changed(); }
  }
  async disconnect() {
    this.ensureIdle(); this.connecting = true;
    try { await this.nas?.logout(); this.nas = null; }
    finally { this.connecting = false; this.changed(); }
  }
  private validateLibrary(library: Library): Space[] {
    const nas = this.nas;
    if (!nas?.connection.connected) throw new AppError('Connect to your NAS first.', 401);
    if (!['personal', 'shared', 'both'].includes(library)) throw new AppError('Invalid library.');
    const spaces: Space[] = library === 'both' ? ['personal', 'shared'] : [library];
    if (spaces.some(space => !nas.connection.spaces.includes(space))) throw new AppError(nas.connection.sharedReason ?? 'Selected library is unavailable for this account.', 409, 'COMPATIBILITY');
    return spaces;
  }
  private async userSkippedKeys(): Promise<Set<string>> {
    const entries = await readJson<{ nasUrl: string; username: string; key: string }[]>(path.join(this.dataDirectory, 'skipped-media.json'), []);
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.nasUrl !== 'string' || typeof entry.username !== 'string' || !/^(personal|shared):\d+:(photo|video|live_video)$/.test(entry.key))) {
      throw new AppError('The skipped-media file contains invalid entries.', 409);
    }
    return new Set(entries.filter(entry => entry.nasUrl === this.settings.nasUrl && entry.username === this.settings.username).map(entry => entry.key));
  }
  private skippedByUser(item: MediaItem): SkippedMedia {
    const { key, space, unitId, filename } = item;
    return { key, space, unitId, filename, reason: 'Skipped by user.' };
  }
  private async fetchBatch(library: Library, signal?: AbortSignal, knownKeys?: ReadonlySet<string>): Promise<ConversionBatch> {
    const spaces = this.validateLibrary(library);
    const skippedKeys = await this.userSkippedKeys();
    const excluded = new Set([...knownKeys ?? [], ...skippedKeys]);
    const results = await Promise.all(spaces.map(space => fetchConversionBatch(this.nas!.request, space, signal, excluded)));
    const pending = results.flatMap(result => result.knownPending ?? []);
    return { items: results.flatMap(result => result.items),
      skipped: [...results.flatMap(result => result.skipped), ...pending.filter(item => skippedKeys.has(item.key)).map(item => this.skippedByUser(item))],
      knownPending: pending.filter(item => !skippedKeys.has(item.key)) };
  }
  async inspectPending(library: Library = this.settings.library): Promise<ConversionBatch> {
    this.ensureIdle();
    return this.fetchBatch(library);
  }
  async start(input: unknown) {
    const options = validateJobInput(input);
    this.ensureIdle(); this.starting = true; this.changed();
    try {
      if (!this.nas?.connection.connected) throw new AppError('Connect to your NAS first.', 401);
      let items: MediaItem[], library: Library;
      let skipped: SkippedMedia[] = [];
      if (options.retryFailed) {
        if (!this.job || !this.job.failedItems().length) throw new AppError('No failed files to retry.', 409);
        library = this.job.library;
        this.validateLibrary(library);
        const skippedKeys = await this.userSkippedKeys();
        const failed = this.job.failedItems();
        items = failed.filter(item => !skippedKeys.has(item.key));
        skipped = failed.filter(item => skippedKeys.has(item.key)).map(item => this.skippedByUser(item));
      } else {
        library = options.library ?? this.settings.library;
        this.validateLibrary(library);
        const settings = { ...this.settings, library };
        await writeJson(path.join(this.dataDirectory, 'settings.json'), settings);
        this.settings = settings;
        ({ items, skipped } = await this.fetchBatch(library));
      }
      if (!items.length) throw new AppError(skipped.length ? `No supported pending previews to process. ${skipped.length} file(s) or component(s) are skipped and remain pending on the NAS.` : 'The NAS returned no pending previews for the selected space. This checks the Synology Photos conversion queue; it does not verify preview files on disk.', 409);
      const batch = await this.launchBatch(library, items, skipped);
      this.batchLoop = this.continueBatches(batch.job, batch.directory);
    } finally { this.starting = false; this.changed(); }
  }
  private async launchBatch(library: Library, items: MediaItem[], skipped: SkippedMedia[]) {
      if (!this.hardware?.ffmpeg || !this.hardware.ffprobe || !this.hardware.magick) throw new AppError('Configure FFmpeg, FFprobe, and ImageMagick before executing.', 409);
      if (!this.hardware.heic && items.some(item => /\.(heic|heif)$/i.test(item.filename))) throw new AppError('HEIC photos require an ImageMagick build with HEIC reading support.', 409);
      const tempRoot = path.resolve(this.settings.tempDirectory || path.join(this.dataDirectory, 'work'));
      await mkdir(tempRoot, { recursive: true });
      const runDirectory = await mkdtemp(path.join(tempRoot, 'preview-run-'));
      const nas = this.nas;
      if (!nas?.connection.connected) throw new AppError('Connect to your NAS first.', 401);
      const converter = new MediaConverter(this.settings, this.hardware);
      const job = new ConversionJob(library, items, this.settings, runDirectory, {
        download: nas.download.bind(nas), convert: converter.convert.bind(converter), upload: nas.upload.bind(nas),
        refillIntervalMs: this.jobOptions.refillIntervalMs,
        refill: async (knownKeys, signal) => this.shuttingDown ? { items: [], skipped: [] } : this.fetchBatch(library, signal, knownKeys)
      }, skipped);
      this.job = job;
      let lastCheckpoint = Date.now();
      job.on('change', () => {
        if (Date.now() - lastCheckpoint >= 5000) { lastCheckpoint = Date.now(); void this.checkpoint(job); }
        this.changed();
      });
      await this.checkpoint(job); job.start(); this.changed();
      return { job, directory: runDirectory };
  }
  private async continueBatches(firstJob: ConversionJob, firstDirectory: string) {
    await firstJob.completion;
    this.finalizing = true; this.changed();
    try {
      try {
        if (this.jobOptions.cleanupRun) await this.jobOptions.cleanupRun(firstDirectory);
        else await rm(firstDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        firstJob.releaseRetainedReservations();
      } catch { firstJob.addWarning('Could not remove the run temporary directory. Its storage reservations remain held.'); }
      await this.checkpoint(firstJob);
    } finally { this.finalizing = false; this.changed(); }
  }
  async shutdown() {
    this.shuttingDown = true; this.job?.stop(); await this.batchLoop;
    await this.persistence; await this.nas?.logout();
  }
}

export function createApp(studio: Studio, port = 4177) {
  const app = express();
  const token = randomBytes(32).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.get('host');
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host ?? '')) return res.status(403).json({ error: 'Use the loopback app address.' });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const allowedOrigins = [origin, `http://localhost:${port}`, 'http://127.0.0.1:5173'];
      if ((req.get('origin') && !allowedOrigins.includes(req.get('origin')!)) || req.get('x-preview-token') !== token || !req.is('application/json')) return res.status(403).json({ error: 'Invalid local app request. Reload the interface.' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/state', (_req, res) => res.json({ ...studio.state(), csrfToken: token }));
  app.get('/api/queue', async (req, res) => {
    const library = req.query.library;
    if (library !== undefined && (typeof library !== 'string' || !['personal', 'shared', 'both'].includes(library))) throw new AppError('Invalid library.');
    res.json(await studio.inspectPending(library as Library | undefined));
  });
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let pending = false;
    const send = () => {
      if (res.writableLength > 1024 * 1024) { pending = true; return; }
      res.write(`data: ${JSON.stringify(studio.state())}\n\n`);
    };
    res.on('drain', () => { if (pending) { pending = false; send(); } });
    send(); studio.on('change', send);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    req.on('close', () => { clearInterval(heartbeat); studio.off('change', send); });
  });
  app.post('/api/connect', async (req, res) => { await studio.connect(req.body); res.json(studio.state()); });
  app.post('/api/disconnect', async (_req, res) => { await studio.disconnect(); res.json(studio.state()); });
  app.post('/api/settings', async (req, res) => { await studio.saveSettings(req.body); res.json(studio.state()); });
  app.post('/api/jobs', async (req, res) => { await studio.start(req.body); res.status(202).json(studio.state()); });
  app.post('/api/jobs/:action', (req, res) => {
    if (!studio.job) throw new AppError('No job is available.', 409);
    if (req.params.action === 'pause') studio.job.pause();
    else if (req.params.action === 'resume') studio.job.resume();
    else if (req.params.action === 'stop') studio.job.stop();
    else throw new AppError('Unknown job action.', 404);
    res.json(studio.state());
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Unknown API endpoint.' }); });
  app.use(express.static(path.join(projectDirectory, 'dist')));
  app.get('/', (_req, res) => res.sendFile(path.join(projectDirectory, 'dist', 'index.html')));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    if ((error as { type?: string })?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Request body must be valid JSON.', code: 'APP_ERROR' });
    if ((error as { type?: string })?.type === 'entity.too.large') return void res.status(413).json({ error: 'Request body is too large.', code: 'APP_ERROR' });
    res.status(error instanceof AppError ? error.status : 500).json({ error: errorMessage(error),
      code: error instanceof AppError ? error.code : 'INTERNAL_ERROR', otpRequired: error instanceof NasError && error.nasCode === 403 });
  });
  return app;
}
