export type Space = 'personal' | 'shared';
export type Library = Space | 'both';
export type Component = 'photo' | 'video' | 'live_video';
export interface MediaItem {
  key: string;
  space: Space;
  unitId: number;
  filename: string;
  component: Component;
  needThumbnail: boolean;
  needVideo: boolean;
  size?: number;
  takenAt?: string;
}
export const mediaDateLookupBatchSize = 100;
export interface SkippedMedia {
  key: string;
  space: Space;
  unitId: number;
  filename: string;
  reason: string;
}
export interface ConversionBatch {
  items: MediaItem[];
  skipped: SkippedMedia[];
  knownPending?: MediaItem[];
}
export interface Settings {
  nasUrl: string;
  username: string;
  library: Library;
  downloads: number;
  images: number;
  videos: number;
  uploads: number;
  softwareThreads: number;
  cq: number;
  ffmpeg: string;
  ffprobe: string;
  magick: string;
  tempDirectory: string;
  diskReserveGiB: number;
  maxStagedGiB: number;
}
export interface Hardware {
  cpu: string;
  logicalCpus: number;
  memoryGiB: number;
  gpu: string | null;
  ffmpeg: boolean;
  ffprobe: boolean;
  magick: boolean;
  heic: boolean;
  nvenc: boolean;
  cudaScale: boolean;
  hdrFilters: boolean;
  warnings: string[];
}
export type Stage = 'queued' | 'waiting' | 'download' | 'convert' | 'upload' | 'done' | 'failed' | 'cancelled';
export interface ItemProgress extends MediaItem {
  stage: Stage;
  percent: number | null;
  backend?: string;
  error?: string;
}
export type JobStatus = 'running' | 'paused' | 'stopping' | 'stopped' | 'completed' | 'completed_with_errors';
export interface JobSnapshot {
  id: string;
  library: Library;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  total: number;
  success: number;
  failed: number;
  cancelled: number;
  remaining: number;
  settledPercent: number;
  filesPerMinute: number;
  etaSeconds: number | null;
  downloadedBytes: number;
  uploadedBytes: number;
  mibPerSecond: number;
  mediaDateFrom?: string;
  mediaDateTo?: string;
  mediaDateActiveCount?: number;
  mediaDateKnownCount?: number;
  skipped?: number;
  warnings?: string[];
  active: ItemProgress[];
  errors: ItemProgress[];
  verificationError?: string;
}
export interface Connection {
  connected: boolean;
  url?: string;
  username?: string;
  spaces: Space[];
  sharedReason?: string;
}
export interface AppState {
  serverId: string;
  revision: number;
  settings: Settings;
  connection: Connection;
  hardware: Hardware | null;
  job: JobSnapshot | null;
  history: JobSnapshot[];
  starting: boolean;
  finalizing: boolean;
}
