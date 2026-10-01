// Disk-backed memory maps also consume the disk cache allowance.
export const imageCacheDiskBytes = 1024 ** 3;
export function imageCacheEnvironment(memoryGiB: number, imageWorkers: number) {
  // Keep half of the memory above a 4 GiB system reserve available for other
  // stages. Memory and map are separate ImageMagick cache resources, so split
  // each worker's share between them and cap both at 1 GiB.
  const usableMiB = Math.max(0, memoryGiB * 1024 - 4096) / 2;
  const perResourceMiB = Math.max(256, Math.min(1024, Math.floor(usableMiB / Math.max(1, imageWorkers) / 2)));
  return {
    MAGICK_THREAD_LIMIT: '1',
    MAGICK_MEMORY_LIMIT: `${perResourceMiB}MiB`,
    MAGICK_MAP_LIMIT: `${perResourceMiB}MiB`,
    MAGICK_DISK_LIMIT: String(imageCacheDiskBytes)
  };
}

