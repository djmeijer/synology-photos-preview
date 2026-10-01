import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, statfs, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, errorMessage } from './errors.ts';
import { imageCacheDiskBytes } from './image-resources.ts';
import type { ConversionBatch, ItemProgress, JobSnapshot, Library, MediaItem, Settings, SkippedMedia } from '../shared/types.ts';
import { mediaDateRange } from '../shared/media-dates.ts';

export class Semaphore {
  private active = 0;
  private waiters: { resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void }[] = [];
  constructor(readonly limit: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: () => {
        this.waiters = this.waiters.filter(w => w !== waiter); reject(signal?.reason);
      } };
      signal?.addEventListener('abort', waiter.abort, { once: true }); this.waiters.push(waiter);
    });
    let released = false;
    return () => {
      if (released) return; released = true;
      const next = this.waiters.shift();
      if (next) { next.signal?.removeEventListener('abort', next.abort); next.resolve(); }
      else this.active--;
    };
  }
  async use<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try { signal.throwIfAborted(); return await operation(); } finally { release(); }
  }
}
export interface JobDependencies {
  download: (item: MediaItem, source: string, signal: AbortSignal, maxBytes: number, progress: (percent: number | null, bytes?: number) => void) => Promise<void>;
  convert: (item: MediaItem, source: string, directory: string, signal: AbortSignal, progress: (percent: number | null, backend: string) => void) => Promise<Record<string, string>>;
  upload: (item: MediaItem, outputs: Record<string, string>, signal: AbortSignal, progress: (percent: number | null, bytes?: number) => void) => Promise<void>;
  reserve?: (item: MediaItem, signal: AbortSignal) => Promise<{ release: () => void; retain?: () => void; maxBytes: number }>;
  refill?: (knownKeys: ReadonlySet<string>, signal: AbortSignal) => Promise<ConversionBatch>;
  refillIntervalMs?: number;
  cleanup?: (directory: string) => Promise<void>;
}
function workPriority(a: MediaItem, b: MediaItem) {
  const video = Number(b.needVideo) - Number(a.needVideo);
  if (video) return video;
  const size = (b.size ?? 0) - (a.size ?? 0);
  if (size) return size;
  return 0;
}
export class DiskBudget {
  private reserved = 0;
  private activeReservations = 0;
  constructor(private settings: Settings, private directory: string,
    private wait = (signal: AbortSignal) => delay(1000, undefined, { signal })) {}
  async acquire(item: MediaItem, signal: AbortSignal) {
    const budget = this.settings.maxStagedGiB * 1024 ** 3;
    const overhead = 64 * 1024 ** 2 + (item.component === 'photo' || item.needThumbnail ? imageCacheDiskBytes : 0);
    const minimum = overhead + 64 * 1024 ** 2;
    const needed = item.size ? item.size * 2 + minimum : Math.max(minimum, budget / this.settings.downloads);
    if (!item.size && needed > budget) throw new AppError('Temporary-disk reservation is too small for the image cache. Increase max staged storage.', 409);
    if (needed > budget) throw new AppError('File exceeds the staged-storage budget. Increase max staged storage.', 409);
    let waits = 0;
    while (true) {
      signal.throwIfAborted();
      const disk = await statfs(this.directory);
      const free = disk.bavail * disk.bsize;
      if (this.reserved + needed > budget && this.activeReservations === 0) throw new AppError('Temporary storage remains reserved after cleanup failures. Finish or stop the run and resolve temporary-file cleanup before retrying.', 409);
      if (free - this.reserved - needed < this.settings.diskReserveGiB * 1024 ** 3 && this.activeReservations === 0) throw new AppError('Insufficient free temporary storage. Free disk space or select another temporary directory.', 409);
      if (this.reserved + needed <= budget && free - this.reserved - needed >= this.settings.diskReserveGiB * 1024 ** 3 && os.freemem() > 1024 ** 3) {
        this.reserved += needed;
        this.activeReservations++;
        let released = false, retained = false;
        return {
          maxBytes: Math.floor((needed - overhead) / 2),
          retain: () => { if (!released && !retained) { retained = true; this.activeReservations--; } },
          release: () => { if (!released) { released = true; this.reserved -= needed; if (!retained) this.activeReservations--; } }
        };
      }
      // Admitted files hold their reservations through upload and cleanup. Long
      // conversions are normal queue backpressure, so keep waiting for them.
      // Retained reservations cannot be released until final run cleanup.
      if (this.activeReservations > 0) waits = 0;
      else if (++waits >= 120) throw new AppError('Available memory stayed at or below 1 GiB for two minutes. Close other applications or reduce workers.', 409);
      await this.wait(signal);
    }
  }
}
export class ConversionJob extends EventEmitter {
  readonly id = randomUUID();
  readonly items: ItemProgress[];
  readonly controller = new AbortController();
  readonly startedAt = new Date().toISOString();
  status: JobSnapshot['status'] = 'running';
  finishedAt?: string;
  verificationError?: string;
  private resumeWaiters: (() => void)[] = [];
  private workWaiters: (() => void)[] = [];
  private finished = false;
  private started = false;
  private sourceDone = false;
  private processing = 0;
  private next = 0;
  private refill: Promise<void> | null = null;
  private nextRefillAt = 0;
  private idleChecks = 0;
  private settlementRevision = 0;
  private retainedReservations: (() => void)[] = [];
  private knownKeys = new Set<string>();
  private lastNotification = 0;
  private downloadedBytes = 0;
  private uploadedBytes = 0;
  private skippedKeys = new Set<string>();
  private warnings = new Set<string>();
  completion!: Promise<void>;
  constructor(readonly library: Library, items: MediaItem[], private settings: Settings, private directory: string, private dependencies: JobDependencies, skipped: SkippedMedia[] = []) {
    super();
    const unique = new Map(items.map(item => [item.key, item]));
    const fetched = [...unique.values()];
    this.items = fetched.sort(workPriority).map(item => this.queuedItem(item));
    this.items.forEach(item => this.knownKeys.add(item.key));
    this.addSkipped(skipped);
  }
  get active() { return !this.finished; }
  start() { if (this.started) throw new AppError('Job has already started.', 409); this.started = true; this.completion = this.run(); return this; }
  pause() { if (this.status !== 'running') throw new AppError('Only a running job can be paused.', 409); this.status = 'paused'; this.resetIdleConfirmation(); this.notify(true); }
  resume() { if (this.status !== 'paused') throw new AppError('Job is not paused.', 409); this.status = 'running'; this.resetIdleConfirmation(); this.wake(); this.notify(true); }
  stop() { if (!this.active) return; this.status = 'stopping'; this.controller.abort(); this.wake(); this.wakeWork(); this.notify(true); }
  private wake() { this.resumeWaiters.splice(0).forEach(resolve => resolve()); }
  private wakeWork() { this.workWaiters.splice(0).forEach(resolve => resolve()); }
  private notify(force = false) {
    if (force || Date.now() - this.lastNotification > 250) { this.lastNotification = Date.now(); this.emit('change'); }
  }
  private queuedItem(item: MediaItem): ItemProgress {
    // Retry inputs can be ItemProgress objects; copy media fields only.
    const { key, space, unitId, filename, component, needThumbnail, needVideo, size, takenAt } = item;
    return { key, space, unitId, filename, component, needThumbnail, needVideo, size, takenAt, stage: 'queued', percent: null };
  }
  addWarning(message: string) {
    if (this.warnings.has(message)) return;
    this.warnings.add(message);
    if (this.status === 'completed') this.status = 'completed_with_errors';
    this.notify(true);
  }
  private addSkipped(items: SkippedMedia[]) {
    for (const item of items) {
      if (this.skippedKeys.has(item.key)) continue;
      this.skippedKeys.add(item.key);
      this.warnings.add(`Skipped ${item.filename} (${item.space}, unit ${item.unitId}): ${item.reason}`);
    }
  }
  private get refillIntervalMs() { return this.dependencies.refillIntervalMs ?? 2000; }
  private resetIdleConfirmation() {
    this.idleChecks = 0; this.settlementRevision++;
    if (this.processing === 0) this.nextRefillAt = Date.now() + this.refillIntervalMs;
  }
  releaseRetainedReservations() { this.retainedReservations.splice(0).forEach(release => release()); }
  private async gate() {
    while (this.status === 'paused') await new Promise<void>(resolve => this.resumeWaiters.push(resolve));
    this.controller.signal.throwIfAborted();
  }
  private async takeNext(): Promise<ItemProgress | null> {
    while (true) {
      await this.gate();
      if (this.next < this.items.length) {
        this.processing++;
        return this.items[this.next++];
      }
      if (this.sourceDone) return null;
      if (!this.dependencies.refill) {
        this.sourceDone = true; this.wakeWork(); return null;
      }
      if (!this.refill) {
        this.refill = (async () => {
          try {
            // Settling work or resuming can move the deadline while a timer is pending.
            while (true) {
              await this.gate();
              const wait = this.nextRefillAt - Date.now();
              if (wait <= 0) break;
              await delay(wait, undefined, { signal: this.controller.signal });
            }
            const revision = this.settlementRevision;
            const idleAtRequest = this.processing === 0;
            const discovered = await this.dependencies.refill!(this.knownKeys, this.controller.signal);
            this.controller.signal.throwIfAborted();
            this.addSkipped(discovered.skipped);
            let added = 0;
            const addedItems: ItemProgress[] = [];
            for (const item of discovered.items) {
              if (this.knownKeys.has(item.key)) continue;
              this.knownKeys.add(item.key);
              addedItems.push(this.queuedItem(item));
              added++;
            }
            this.items.push(...addedItems.sort(workPriority));
            if (added) this.resetIdleConfirmation();
            this.nextRefillAt = added ? 0 : Date.now() + this.refillIntervalMs;
            // Only fresh requests made after all work settled can confirm exhaustion.
            if (!added && idleAtRequest && this.processing === 0 && revision === this.settlementRevision && this.status === 'running') {
              if (++this.idleChecks >= 3) {
                this.sourceDone = true;
                const doneKeys = new Set(this.items.filter(item => item.stage === 'done').map(item => item.key));
                const stillPending = discovered.knownPending ?? discovered.items;
                for (const item of stillPending) {
                  if (!doneKeys.has(item.key)) continue;
                  const previews = [item.needThumbnail ? 'thumbnails' : '', item.needVideo ? 'H.264 video preview' : ''].filter(Boolean).join(' and ');
                  if (!previews) continue;
                  this.addWarning(`NAS still requests ${previews} for ${item.filename} (${item.space}, unit ${item.unitId}) after acknowledging its upload. The queue has not cleared for this file; Execute now may return it again.`);
                }
              }
            }
          } catch (error) {
            if (!this.controller.signal.aborted) this.verificationError = errorMessage(error);
            this.sourceDone = true;
          } finally {
            this.refill = null; this.wakeWork(); this.notify(true);
          }
        })();
      }
      await this.refill;
      if (this.next < this.items.length) continue;
      if (this.sourceDone) return null;
      // NAS can briefly repeat the same capped page after uploads. Keep one
      // throttled refill alive so idle workers can discover the next page
      // while a slow conversion is still running.
    }
  }
  private async run() {
    const downloads = new Semaphore(this.settings.downloads), images = new Semaphore(this.settings.images), videos = new Semaphore(this.settings.videos), uploads = new Semaphore(this.settings.uploads);
    const disk = new DiskBudget(this.settings, this.directory);
    const worker = async () => {
      while (true) {
        let item: ItemProgress | null;
        try { item = await this.takeNext(); } catch { break; }
        if (!item) break;
        let itemDirectory: string | undefined, release: (() => void) | undefined, retain: (() => void) | undefined;
        try {
          const signal = this.controller.signal;
          item.stage = 'waiting'; this.notify(true);
          let source = '', maxBytes = 0;
          await downloads.use(signal, async () => {
            await this.gate();
            const reservation = await (this.dependencies.reserve?.(item, signal) ?? disk.acquire(item, signal));
            release = reservation.release; retain = reservation.retain; maxBytes = reservation.maxBytes;
            await this.gate();
            itemDirectory = await mkdtemp(path.join(this.directory, 'item-'));
            // NAS filenames are labels only; never use them as filesystem paths.
            const extension = path.extname(item.filename).match(/^\.[a-zA-Z0-9]{1,8}$/)?.[0] ?? '.bin';
            source = path.join(itemDirectory, `source${extension}`);
            await this.gate();
            item.stage = 'download'; item.percent = 0; this.notify(true);
            let previousBytes = 0;
            await this.dependencies.download(item, source, signal, maxBytes, (percent, bytes = 0) => {
              this.downloadedBytes += bytes >= previousBytes ? bytes - previousBytes : bytes;
              previousBytes = bytes; item.percent = percent; this.notify();
            });
          });
          await (item.component === 'photo' ? images : videos).use(signal, async () => {
            const conversion = async () => {
              item.stage = 'convert'; item.percent = null; this.notify(true);
              return this.dependencies.convert(item, source, itemDirectory!, signal, (percent, backend) => { item.percent = percent; item.backend = backend; this.notify(); });
            };
            const outputs = await conversion();
            const outputSize = (await Promise.all(Object.values(outputs).map(filename => stat(filename)))).reduce((sum, info) => sum + info.size, 0);
            if (outputSize > maxBytes) throw new AppError('Generated previews exceeded their temporary-storage reservation.', 409);
            // Upload has its own semaphore. Release the conversion slot before waiting for it.
            Object.assign(item, { stage: 'waiting', percent: null });
            return outputs;
          }).then(outputs => uploads.use(signal, async () => {
            item.stage = 'upload'; item.percent = 0; this.notify(true);
            let previousBytes = 0;
            await this.dependencies.upload(item, outputs, signal, (percent, bytes = 0) => {
              this.uploadedBytes += bytes >= previousBytes ? bytes - previousBytes : bytes;
              previousBytes = bytes; item.percent = percent; this.notify();
            });
            item.stage = 'done'; item.percent = 100;
          }));
        } catch (error) {
          if (this.controller.signal.aborted) { item.stage = 'cancelled'; item.percent = null; }
          else { item.stage = 'failed'; item.error = errorMessage(error); item.percent = null; }
        } finally {
          let cleaned = true;
          if (itemDirectory) {
            try {
              if (this.dependencies.cleanup) await this.dependencies.cleanup(itemDirectory);
              else await rm(itemDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
            } catch { cleaned = false; this.addWarning(`Temporary-file cleanup failed for ${item.filename}. Storage remains reserved until run cleanup succeeds.`); }
          }
          if (cleaned) release?.(); else if (release) { retain?.(); this.retainedReservations.push(release); }
          this.processing--; this.resetIdleConfirmation(); this.wakeWork(); this.notify(true);
        }
      }
    };
    const workers = Math.max(1, this.settings.downloads + this.settings.images + this.settings.videos + this.settings.uploads);
    await Promise.all(Array.from({ length: workers }, worker));
    if (this.controller.signal.aborted) {
      this.items.filter(item => item.stage === 'queued').forEach(item => { item.stage = 'cancelled'; });
      this.status = 'stopped';
    } else this.status = this.items.some(item => item.stage === 'failed') || this.warnings.size || this.verificationError ? 'completed_with_errors' : 'completed';
    this.finished = true; this.finishedAt = new Date().toISOString(); this.notify(true);
    this.emit('finished');
  }
  failedItems() { return this.items.filter(item => item.stage === 'failed'); }
  snapshot(): JobSnapshot {
    const active = this.items.filter(i => ['waiting', 'download', 'convert', 'upload'].includes(i.stage));
    const success = this.items.filter(i => i.stage === 'done').length;
    const failed = this.items.filter(i => i.stage === 'failed').length;
    const cancelled = this.items.filter(i => i.stage === 'cancelled').length;
    const remaining = this.items.length - success - failed - cancelled;
    const seconds = Math.max(1, ((this.finishedAt ? Date.parse(this.finishedAt) : Date.now()) - Date.parse(this.startedAt)) / 1000);
    return { id: this.id, library: this.library, status: this.status, startedAt: this.startedAt, finishedAt: this.finishedAt,
      total: this.items.length, success, failed, cancelled, remaining, settledPercent: this.items.length ? (success + failed + cancelled) / this.items.length * 100 : 100,
      filesPerMinute: success / seconds * 60, etaSeconds: success > 0 && this.status === 'running' ? Math.round(remaining * seconds / success) : null,
      downloadedBytes: this.downloadedBytes, uploadedBytes: this.uploadedBytes, mibPerSecond: (this.downloadedBytes + this.uploadedBytes) / seconds / 1024 ** 2,
      ...mediaDateRange(active),
      skipped: this.skippedKeys.size, warnings: [...this.warnings],
      active, errors: this.failedItems(), verificationError: this.verificationError };
  }
}
