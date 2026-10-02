import os from 'node:os';
import path from 'node:path';
import { mkdir, readdir, stat, writeFile, rm, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { command } from '../server/process.ts';
import { parseVideoInfo, videoArgs, videoDimensions } from '../server/media.ts';
import { localSettings } from './tools.ts';

// Conversion only: local, complete source files; identical duration, CQ, audio,
// and MP4 muxing. Does not change application settings or upload anything.
const settings = await localSettings();
const sampleDirectory = path.resolve(process.argv[2] ?? '.benchmarks/video-pipeline/samples');
const directory = path.resolve('.benchmarks/video-pipeline');
await mkdir(directory, { recursive: true });
const seconds = Number(process.env.VIDEO_BENCH_SECONDS ?? 30);
const repetitions = Number(process.env.VIDEO_BENCH_REPETITIONS ?? 3);
const signal = new AbortController().signal;
type Sample = { filename: string; info: ReturnType<typeof parseVideoInfo>; codec: string; pixelFormat: string; frameRate: string; bytes: number };
const samples: Sample[] = [];
for (const filename of (await readdir(sampleDirectory)).filter(name => /\.(mp4|mov|mkv|m4v)$/i.test(name))) {
  const source = path.join(sampleDirectory, filename);
  try {
    const raw = JSON.parse(await command(settings.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source]));
    const info = parseVideoInfo(raw), stream = raw.streams.find((s: any) => s.index === info.streamIndex);
    if (info.hdr || info.rotation) { console.log(`Skipped ${filename}: HDR/rotation is outside the CUDA pipeline.`); continue; }
    if (!['h264', 'hevc'].includes(stream.codec_name)) continue;
    samples.push({ filename: source, info, codec: stream.codec_name, pixelFormat: stream.pix_fmt, frameRate: stream.avg_frame_rate, bytes: (await stat(source)).size });
  } catch (error) { console.log(`Skipped invalid sample ${filename}: ${String(error).slice(-250)}`); }
}
if (!samples.length) throw new Error('Provide complete, unrotated SDR H.264/HEVC videos.');
const version = (await command(settings.ffmpeg, ['-version'])).split('\n')[0];
const gpu = await command('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader']);
const variants = ['cuda-current', 'cuda-nv12', 'cuda-bilinear', 'cuda-extra-frames', 'cuda-early-fps', 'cuvid-resize', 'cpu-current', 'cpu-early-fps', 'cpu-gpu-scale', 'cpu-gpu-nv12', 'cpu-gpu-16-threads'] as const;
type Variant = typeof variants[number];
function args(sample: Sample, variant: Variant, destination: string) {
  const source = sample.filename;
  const dimensions = videoDimensions(sample.info);
  const base = videoArgs(source, destination, sample.info, settings, variant.startsWith('cpu') ? 'nvenc' : 'cuda');
  base.splice(base.indexOf('-i') + 2, 0, '-t', String(Math.min(seconds, sample.info.duration)));
  const vf = base.indexOf('-vf') + 1;
  const scale = `scale_cuda=${dimensions.width}:${dimensions.height}`;
  const [rateNumerator, rateDenominator] = sample.frameRate.split('/').map(Number);
  const earlyFps = rateNumerator / rateDenominator > 30 ? 'fps=30,' : '';
  if (variant === 'cuda-nv12') base[vf] = `${scale}:format=nv12,setsar=1`;
  if (variant === 'cuda-bilinear') base[vf] = `${scale}:format=nv12:interp_algo=bilinear,setsar=1`;
  if (variant === 'cuda-extra-frames') { base[vf] = `${scale}:format=nv12,setsar=1`; base.splice(base.indexOf('-i'), 0, '-extra_hw_frames', '16'); }
  if (variant === 'cuda-early-fps') base[vf] = `${earlyFps}${scale}:format=nv12,setsar=1`;
  if (variant === 'cpu-early-fps') base[vf] = `${earlyFps}${base[vf]}`;
  if (variant === 'cuvid-resize') {
    base.splice(base.indexOf('-i'), 0, '-c:v', `${sample.codec}_cuvid`, '-resize', `${dimensions.width}x${dimensions.height}`);
    // NVENC H.264 requires 8-bit frames; CUVID retains source bit depth.
    base[base.indexOf('-vf') + 1] = /10|12/.test(sample.pixelFormat) ? `scale_cuda=format=nv12,setsar=1` : 'setsar=1';
  }
  if (variant === 'cpu-gpu-scale' || variant === 'cpu-gpu-nv12' || variant === 'cpu-gpu-16-threads') {
    base.splice(base.indexOf('-i'), 0, '-init_hw_device', 'cuda=bench:0', '-filter_hw_device', 'bench');
    base[base.indexOf('-vf') + 1] = variant !== 'cpu-gpu-nv12'
      ? `${earlyFps}format=yuv420p,hwupload_cuda,${scale}:format=yuv420p,setsar=1`
      : `${earlyFps}format=nv12,hwupload_cuda,${scale}:format=nv12,setsar=1`;
    if (variant === 'cpu-gpu-16-threads') base[base.indexOf('-threads') + 1] = '16';
  }
  return base;
}
const result: any = { measuredAt: new Date().toISOString(), version, cpu: os.cpus()[0]?.model, logicalCpus: os.availableParallelism(), gpu: gpu.trim(), seconds, repetitions, settings: { softwareThreads: settings.softwareThreads, cq: settings.cq }, samples, single: [], batches: [], commands: {}, validation: [] };
if (process.env.VIDEO_BENCH_RESUME === '1') {
  const previous = JSON.parse(await readFile(path.join(directory, 'latest.json'), 'utf8'));
  if (previous.seconds !== seconds || JSON.stringify(previous.settings) !== JSON.stringify(result.settings) || JSON.stringify(previous.samples) !== JSON.stringify(samples)) throw new Error('Checkpoint uses different inputs or settings.');
  result.single = previous.single;
  result.commands = previous.commands;
  result.previousMeasuredAt = previous.measuredAt;
}
async function save() { await writeFile(path.join(directory, 'latest.json'), JSON.stringify(result, null, 2)); }
async function measure(sample: Sample, variant: Variant, name: string, retain = false) {
  const output = path.join(directory, `${name}.mp4`);
  const argv = args(sample, variant, output);
  result.commands[`${path.basename(sample.filename)}:${variant}`] = argv;
  const start = performance.now();
  try {
    await command(settings.ffmpeg, argv, { signal, timeoutMs: 180_000 });
    const elapsed = (performance.now() - start) / 1000;
    const bytes = (await stat(output)).size;
    return { elapsed, bytes, output };
  } finally { if (!retain) await rm(output, { force: true }); }
}
// A discarded warm-up avoids comparing DLL/CUDA initialization and cold reads
// against already-warm runs. Rotating variant order reduces order bias.
await measure(samples[0], 'cuda-current', 'warmup');
for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
  const sample = samples[sampleIndex];
  const rows = new Map<Variant, any>(variants.map(variant => [variant, result.single.find((row: any) => row.sample === path.basename(sample.filename) && row.variant === variant) ?? { sample: path.basename(sample.filename), variant, runs: [], bytes: [], error: null }]));
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const order = [...variants.slice(repetition), ...variants.slice(0, repetition)];
    for (const variant of order) {
      const row = rows.get(variant)!;
      if (row.error || row.runs.length > repetition) continue;
      try {
        const measured = await measure(sample, variant, `single-${sampleIndex}-${variant}`);
        row.runs.push(measured.elapsed); row.bytes.push(measured.bytes);
        console.log(`${sampleIndex + 1}/${samples.length} ${variant} run ${repetition + 1}: ${measured.elapsed.toFixed(3)}s`);
      } catch (error) { row.error = String(error); console.log(`${variant} failed: ${row.error.slice(-400)}`); }
      result.single = result.single.filter((old: any) => old.sample !== row.sample || old.variant !== row.variant);
      result.single.push(row);
      await save();
    }
  }
  for (const row of rows.values()) {
    row.medianSeconds = row.runs.length ? [...row.runs].sort((a, b) => a - b)[Math.floor(row.runs.length / 2)] : null;
    row.realtimeSpeed = row.medianSeconds ? Math.min(seconds, sample.info.duration) / row.medianSeconds : null;
    result.single = result.single.filter((old: any) => old.sample !== row.sample || old.variant !== row.variant);
    result.single.push(row);
  }
  await save();
}
// Four equal jobs per sample keep total work constant across worker counts.
// Include both homogeneous and mixed decoder pools.
const valid = variants.filter(variant => !result.single.some((row: any) => row.variant === variant && row.error));
const totals = valid.map(variant => ({ variant, seconds: result.single.filter((row: any) => row.variant === variant).reduce((sum: number, row: any) => sum + row.medianSeconds, 0) })).sort((a, b) => a.seconds - b.seconds);
const fastestCuda = totals.find(row => !row.variant.startsWith('cpu'))!.variant;
const fastestCpu = totals.find(row => row.variant.startsWith('cpu'))!.variant;
const plans: { name: string; lanes: Variant[] }[] = [
  ...(fastestCuda !== 'cuda-current' ? [{ name: 'cuda-current-1', lanes: ['cuda-current' as Variant] }] : []),
  ...[1, 2, 4].map(count => ({ name: `${fastestCuda}-${count}`, lanes: Array.from({ length: count }, () => fastestCuda) })),
  { name: 'mixed-1-cuda-1-cpu', lanes: [fastestCuda, fastestCpu] },
  { name: 'mixed-1-cuda-2-cpu', lanes: [fastestCuda, fastestCpu, fastestCpu] },
  { name: 'mixed-1-cuda-4-cpu', lanes: [fastestCuda, fastestCpu, fastestCpu, fastestCpu, fastestCpu] }
];
result.batchRepetitions = Number(process.env.VIDEO_BENCH_BATCH_REPETITIONS ?? 2);
result.fastestSingle = totals;
await save();
for (const plan of plans) {
  const runs: number[] = [], counts: Record<string, number>[] = [];
  for (let repetition = 0; repetition < result.batchRepetitions; repetition++) {
    const jobs = Array.from({ length: samples.length * 4 }, (_, index) => samples[index % samples.length]);
    let next = 0;
    const laneCounts: Record<string, number> = {};
    const start = performance.now();
    await Promise.all(plan.lanes.map(async (variant, lane) => {
      while (next < jobs.length) {
        const index = next++;
        await measure(jobs[index], variant, `batch-${lane}`);
        laneCounts[variant] = (laneCounts[variant] ?? 0) + 1;
      }
    }));
    const elapsed = (performance.now() - start) / 1000;
    runs.push(elapsed); counts.push(laneCounts);
    console.log(`Batch ${plan.name} run ${repetition + 1}: ${elapsed.toFixed(3)}s (${(jobs.length / elapsed).toFixed(2)} clips/s)`);
  }
  const sorted = [...runs].sort((a, b) => a - b);
  const medianSeconds = (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
  result.batches.push({ ...plan, runs, counts, medianSeconds, clipsPerSecond: samples.length * 4 / medianSeconds });
  await save();
}
// Verify the baseline and shortlisted winners against the preview contract, including a complete
// decode of each retained output. Keep these outputs for visual inspection.
for (let index = 0; index < samples.length; index++) {
  for (const variant of new Set<Variant>(['cuda-current', fastestCuda, fastestCpu])) {
    const sample = samples[index], dimensions = videoDimensions(sample.info);
    const measured = await measure(sample, variant, `validated-${index}-${variant}`, true);
    const raw = JSON.parse(await command(settings.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', measured.output]));
    const video = raw.streams.find((s: any) => s.codec_type === 'video');
    const duration = Number(raw.format.duration), expected = Math.min(seconds, sample.info.duration);
    const [n, d] = video.avg_frame_rate.split('/').map(Number);
    if (video.codec_name !== 'h264' || !['yuv420p', 'yuvj420p'].includes(video.pix_fmt) || video.width !== dimensions.width || video.height !== dimensions.height || n / d > 30.01 || Math.abs(duration - expected) > 0.25) throw new Error(`Invalid preview: ${measured.output}`);
    await command(settings.ffmpeg, ['-v', 'error', '-xerror', '-i', measured.output, '-f', 'null', '-'], { timeoutMs: 60_000 });
    result.validation.push({ sample: path.basename(sample.filename), variant, width: video.width, height: video.height, pixelFormat: video.pix_fmt, colorRange: video.color_range, fps: n / d, duration, bytes: measured.bytes, completeDecode: true, audio: raw.streams.filter((s: any) => s.codec_type === 'audio').map((s: any) => s.codec_name) });
  }
}
result.fastestSingle = totals;
result.fastestBatch = [...result.batches].sort((a, b) => a.medianSeconds - b.medianSeconds);
await save();
console.log(`Report: ${path.join(directory, 'latest.json')}`);
console.log(JSON.stringify({ fastestSingle: totals.slice(0, 3), fastestBatch: result.fastestBatch.slice(0, 3).map(({ name, medianSeconds, clipsPerSecond }: any) => ({ name, medianSeconds, clipsPerSecond })) }, null, 2));
