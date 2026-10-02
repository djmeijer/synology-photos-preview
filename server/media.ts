import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { command } from './process.ts';
import { AppError } from './errors.ts';
import { Semaphore } from './queue.ts';
import { imageCacheEnvironment } from './image-resources.ts';
import type { Hardware, MediaItem, Settings } from '../shared/types.ts';

export interface VideoInfo { streamIndex: number; width: number; height: number; duration: number; rotation: number; hdr: boolean; inputBitstreamFilter?: string; }
export function parseVideoInfo(data: any): VideoInfo {
  const stream = data.streams?.find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!stream || !stream.width || !stream.height) throw new AppError('No usable video stream found.', 409, 'TOOL_ERROR');
  const streamIndex = stream.index ?? data.streams.indexOf(stream);
  if (!Number.isSafeInteger(streamIndex) || streamIndex < 0) throw new AppError('Invalid video stream index.', 409, 'TOOL_ERROR');
  const rotation = Number(stream.side_data_list?.find((s: any) => s.rotation != null)?.rotation ?? stream.tags?.rotate ?? 0);
  let width = Number(stream.width), height = Number(stream.height);
  const sar = String(stream.sample_aspect_ratio ?? '1:1').split(':').map(Number);
  if (sar.length === 2 && sar[0] > 0 && sar[1] > 0) width = Math.round(width * sar[0] / sar[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2 || !Number.isFinite(rotation)) throw new AppError('Invalid video dimensions or orientation.', 409, 'TOOL_ERROR');
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  // FFmpeg 7 rejects the reserved matrix value (3) before any video filter can
  // run, reporting it as "Invalid color range". Correct the compressed stream
  // on input so thumbnails and every encoding backend see usable metadata.
  // Use the advertised primaries where possible, otherwise mark it unspecified.
  const matrix = ({ bt709: 1, bt470bg: 5, smpte170m: 6, smpte240m: 7, bt2020: 9 } as Record<string, number>)[stream.color_primaries] ?? 2;
  const inputBitstreamFilter = stream.color_space === 'reserved' && ['h264', 'hevc'].includes(stream.codec_name)
    ? `${stream.codec_name}_metadata=matrix_coefficients=${matrix}` : undefined;
  return { streamIndex, width, height, rotation, duration: Number(data.format?.duration ?? stream.duration) || 0,
    hdr: ['smpte2084', 'arib-std-b67'].includes(stream.color_transfer),
    ...(inputBitstreamFilter ? { inputBitstreamFilter } : {}) };
}
export function videoInputArgs(source: string, info: VideoInfo): string[] {
  return [...(info.inputBitstreamFilter ? [`-bsf:${info.streamIndex}`, info.inputBitstreamFilter] : []), '-i', source];
}
export function videoDimensions(info: VideoInfo, shortEdge = 720) {
  const factor = Math.min(1, shortEdge / Math.min(info.width, info.height));
  return { width: Math.max(2, Math.floor(info.width * factor / 2) * 2), height: Math.max(2, Math.floor(info.height * factor / 2) * 2) };
}
export function softwareFilters(info: VideoInfo, width: number, height: number) {
  if (info.hdr) {
    // Resize while zscale converts to linear light so the expensive float RGB
    // tone-map runs on preview-sized frames instead of the full source frame.
    return `zscale=w=${width}:h=${height}:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,setsar=1,format=yuv420p`;
  }
  return `scale=${width}:${height},setsar=1,format=yuv420p`;
}
export function videoArgs(source: string, destination: string, info: VideoInfo, settings: Settings, mode: 'cuda' | 'nvenc' | 'software'): string[] {
  const dimensions = videoDimensions(info);
  const filter = mode === 'cuda' ? `scale_cuda=${dimensions.width}:${dimensions.height}:format=yuv420p,setsar=1` : softwareFilters(info, dimensions.width, dimensions.height);
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', String(settings.softwareThreads),
    ...(mode === 'cuda' ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : []),
    ...videoInputArgs(source, info), '-map', `0:${info.streamIndex}`, '-map', '0:a:0?', '-vf', filter,
    ...(mode === 'software' ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(settings.cq)]
      : ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'hq', '-rc', 'vbr', '-cq', String(settings.cq), '-b:v', '0', '-multipass', 'disabled']),
    // Synology previews do not benefit from high-speed source frame rates. This
    // leaves 24/25/30 fps media untouched and avoids encoding up to 8x as many
    // frames for 60-240 fps camera footage.
    '-fpsmax', '30',
    '-threads', String(settings.softwareThreads), '-filter_threads', String(settings.softwareThreads),
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0',
    ...(info.hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
    '-progress', 'pipe:1', '-nostats', destination];
}
export async function inspectHardware(settings: Settings): Promise<Hardware> {
  const hardware: Hardware = { cpu: os.cpus()[0]?.model ?? 'Unknown CPU', logicalCpus: os.availableParallelism(),
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3), gpu: null, ffmpeg: false, ffprobe: false, magick: false,
    heic: false, nvenc: false, cudaScale: false, hdrFilters: false, warnings: [] };
  const checks = await Promise.allSettled([
    command(settings.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 }),
    command(settings.ffprobe, ['-version'], { timeoutMs: 10_000 }),
    command(settings.magick, ['-list', 'format'], { timeoutMs: 10_000 }),
    command(settings.ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 10_000 }),
    command('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeoutMs: 10_000 })
  ]);
  hardware.ffmpeg = checks[0].status === 'fulfilled';
  hardware.ffprobe = checks[1].status === 'fulfilled';
  hardware.magick = checks[2].status === 'fulfilled';
  hardware.heic = checks[2].status === 'fulfilled' && /^\s*HEIC\*?\s+(?:\S+\s+)?r[-w+]/m.test(checks[2].value);
  if (checks[3].status === 'fulfilled') {
    hardware.cudaScale = checks[3].value.includes('scale_cuda');
    hardware.hdrFilters = checks[3].value.includes('zscale') && checks[3].value.includes(' tonemap ');
  }
  if (checks[4].status === 'fulfilled') hardware.gpu = checks[4].value.trim();
  if (checks[0].status === 'fulfilled' && checks[0].value.includes('h264_nvenc')) {
    try {
      await command(settings.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
        '-frames:v', '8', '-c:v', 'h264_nvenc', '-preset', 'p1', '-f', 'null', '-'], { timeoutMs: 20_000 });
      hardware.nvenc = true;
    } catch { hardware.warnings.push('NVIDIA encoder is listed but its smoke test failed; software encoding will be used.'); }
  }
  if (!hardware.ffmpeg || !hardware.ffprobe) hardware.warnings.push('Install FFmpeg and FFprobe or set their executable paths.');
  if (!hardware.magick) hardware.warnings.push('Install ImageMagick 7 or set its executable path.');
  else if (!hardware.heic) hardware.warnings.push('ImageMagick cannot read HEIC. Install a build with the libheif delegate.');
  if (!hardware.nvenc) hardware.warnings.push('NVIDIA acceleration is unavailable. Video conversion will use the CPU.');
  return hardware;
}
export class MediaConverter {
  private cpu: Semaphore;
  constructor(private settings: Settings, private hardware: Hardware) {
    this.cpu = new Semaphore(Math.max(1, Math.floor(Math.max(1, hardware.logicalCpus - 2) / settings.softwareThreads)));
  }
  private async thumbnails(source: string, directory: string, signal: AbortSignal): Promise<Record<string, string>> {
    const outputs = Object.fromEntries(['sm', 'm', 'xl'].map(size => [`thumb_${size}`, path.join(directory, `thumb_${size}.jpg`)]));
    const args = [`${source}[0]`, '-auto-orient', '-colorspace', 'sRGB', '-strip', '-background', 'white', '-alpha', 'remove', '-alpha', 'off',
      // Build a thumbnail pyramid. The expensive full-resolution resize happens
      // once; the 320px and 240px files are derived from the 1280px result.
      '-thumbnail', '1280x1280^>', '-write', 'mpr:xl', '-quality', '90', '-write', outputs.thumb_xl,
      '(', 'mpr:xl', '-thumbnail', '320x320^>', '-write', 'mpr:m', '-quality', '90', '-write', outputs.thumb_m, '+delete', ')',
      '(', 'mpr:m', '-thumbnail', '240x240^>', '-quality', '90', '-write', outputs.thumb_sm, '+delete', ')'];
    args.push('null:');
    await command(this.settings.magick, args, { signal, env: {
      ...imageCacheEnvironment(this.hardware.memoryGiB, this.settings.images), MAGICK_TEMPORARY_PATH: directory
    } });
    return outputs;
  }
  async convert(item: MediaItem, source: string, directory: string, signal: AbortSignal, report: (percent: number | null, backend: string) => void) {
    if (item.component === 'photo') {
      report(null, 'CPU · ImageMagick');
      return this.thumbnails(source, directory, signal);
    }
    const raw = await command(this.settings.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source], { signal });
    const info = parseVideoInfo(JSON.parse(raw));
    if (info.hdr && !this.hardware.hdrFilters) throw new AppError('HDR media requires an FFmpeg build with zscale and tonemap filters.', 409, 'TOOL_ERROR');
    const outputs: Record<string, string> = {};
    if (item.needThumbnail) {
      report(null, 'CPU · early video frame');
      const frame = path.join(directory, 'frame.jpg');
      const dims = videoDimensions(info, 1280);
      await this.cpu.use(signal, () => command(this.settings.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', String(this.settings.softwareThreads),
        '-filter_threads', String(this.settings.softwareThreads), ...videoInputArgs(source, info), '-map', `0:${info.streamIndex}`, '-vf', softwareFilters(info, dims.width, dims.height), '-frames:v', '1', '-update', '1', frame], { signal }));
      Object.assign(outputs, await this.thumbnails(frame, directory, signal));
    }
    if (item.needVideo) {
      const destination = path.join(directory, 'film_h264.mp4');
      const modes: ('cuda' | 'nvenc' | 'software')[] = this.hardware.nvenc
        ? [...(this.hardware.cudaScale && !info.hdr && !info.rotation ? ['cuda' as const] : []), 'nvenc', 'software'] : ['software'];
      for (let index = 0; index < modes.length; index++) {
        const mode = modes[index];
        report(0, mode === 'cuda' ? 'NVIDIA decode / scale / encode' : mode === 'nvenc' ? 'CPU decode · NVIDIA encode' : 'CPU · H.264');
        try {
          const execute = () => command(this.settings.ffmpeg, videoArgs(source, destination, info, this.settings, mode), { signal, line: line => {
            if (line.startsWith('out_time_us=') && info.duration > 0) report(Math.min(99.9, Number(line.slice(12)) / 1_000_000 / info.duration * 100), mode);
          } });
          if (mode === 'cuda') await execute(); else await this.cpu.use(signal, execute);
          outputs.film_h264 = destination;
          break;
        } catch (error) {
          signal.throwIfAborted(); await rm(destination, { force: true });
          if (index === modes.length - 1) throw error;
        }
      }
    }
    return outputs;
  }
}
