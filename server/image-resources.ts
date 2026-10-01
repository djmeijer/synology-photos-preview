// Disk-backed memory maps also consume the disk cache allowance.
export const imageCacheDiskBytes = 1024 ** 3;
export const imageCacheEnvironment = {
  MAGICK_THREAD_LIMIT: '1',
  MAGICK_MEMORY_LIMIT: '256MiB',
  MAGICK_MAP_LIMIT: '256MiB',
  MAGICK_DISK_LIMIT: String(imageCacheDiskBytes)
};

