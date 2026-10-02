import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { parseVideoInfo, videoArgs, videoInputArgs, videoDimensions, softwareFilters, inspectHardware, MediaConverter } from '../server/media.ts';
import { defaults } from '../server/settings.ts';
import { command } from '../server/process.ts';
import { imageCacheEnvironment } from '../server/image-resources.ts';
import { localSettings } from '../scripts/tools.ts';
import { fixtures } from '../scripts/fixtures.ts';
import type { MediaItem } from '../shared/types.ts';

test('rotated, odd, portrait and small video dimensions preserve the aspect ratio without upscaling', () => {
  const info = parseVideoInfo({ streams: [{ codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }], format: { duration: '10' } });
  assert.deepEqual(videoDimensions(info), { width: 720, height: 1280 });
  assert.deepEqual(videoDimensions({ ...info, width: 639, height: 359 }), { width: 638, height: 358 });
  const hdr = videoArgs('in.mp4', 'out.mp4', { ...info, hdr: true }, defaults, 'nvenc');
  assert.ok(hdr.includes('0:a:0?')); assert.ok(hdr.includes('p1')); assert.ok(hdr.includes('23')); assert.ok(hdr.some(x => x.includes('tonemap=')));
  assert.equal(hdr[hdr.indexOf('-fpsmax') + 1], '30');
  const hdrFilter = softwareFilters({ ...info, hdr: true }, 720, 1280);
  assert.match(hdrFilter, /^zscale=w=720:h=1280:t=linear/);
  assert.doesNotMatch(hdrFilter, /(?:^|,)scale=720:1280/);
});

test('encoding maps the probed movie stream instead of preceding cover art', () => {
  const info = parseVideoInfo({ streams: [
    { index: 0, codec_type: 'video', width: 300, height: 300, disposition: { attached_pic: 1 } },
    { index: 2, codec_type: 'video', width: 1920, height: 1080 }
  ], format: { duration: '5' } });
  assert.equal(info.streamIndex, 2);
  for (const mode of ['cuda', 'nvenc', 'software'] as const) {
    const args = videoArgs('in.mp4', 'out.mp4', info, defaults, mode);
    assert.equal(args[args.indexOf('-map') + 1], '0:2');
  }
  assert.throws(() => parseVideoInfo({ streams: [{ codec_type: 'video', index: -1, width: 2, height: 2 }] }), /stream index/);
});
test('real FFmpeg/ImageMagick conversions: HEIC, rotated, HEVC 10-bit, HDR, silent and corrupt media', { skip: process.env.MEDIA_TESTS !== '1', timeout: 180_000 }, async t => {
  const settings = await localSettings(), hardware = await inspectHardware(settings);
  assert.equal(hardware.magick, true); assert.equal(hardware.heic, true);
  const samples = await fixtures(settings), converter = new MediaConverter(settings, hardware);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-media-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [index, name] of ['example.heic', 'rotated.mp4', 'hevc10.mp4', 'hdr.mp4', 'silent.mp4'].entries()) {
    await t.test(name, async () => {
      const outputDirectory = await mkdtemp(path.join(directory, 'item-'));
      const item: MediaItem = { key: `personal:${index}:${name}`, unitId: index, space: 'personal', component: name.endsWith('heic') ? 'photo' : 'video', filename: name, needThumbnail: true, needVideo: !name.endsWith('heic') };
      const outputs = await converter.convert(item, samples.file(name), outputDirectory, new AbortController().signal, () => {});
      assert.equal(Object.keys(outputs).length, item.component === 'photo' ? 3 : 4);
      for (const [key, output] of Object.entries(outputs)) {
        assert.ok((await stat(output)).size > 0);
        if (key.startsWith('thumb_')) {
          const dimensions = (await command(settings.magick, ['identify', '-format', '%w %h', output])).split(' ').map(Number);
          const target = { thumb_sm: 240, thumb_m: 320, thumb_xl: 1280 }[key]!;
          assert.ok(Math.min(...dimensions) <= target); assert.ok(Math.min(...dimensions) >= Math.min(target, 854) - 2);
        }
      }
      if (outputs.film_h264) {
        const result = JSON.parse(await command(settings.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', outputs.film_h264]));
        const video = result.streams.find((s: any) => s.codec_type === 'video');
        assert.equal(video.codec_name, 'h264'); assert.equal(video.pix_fmt, 'yuv420p'); assert.equal(Math.min(video.width, video.height), 720);
        if (name === 'rotated.mp4') { assert.equal(video.width, 720); assert.equal(video.height, 1280); }
        if (name === 'hdr.mp4') assert.equal(video.color_transfer, 'bt709');
        assert.equal(result.streams.some((s: any) => s.codec_type === 'audio'), name === 'rotated.mp4');
      }
    });
  }
  await assert.rejects(converter.convert({ key: 'corrupt', unitId: 999, space: 'personal', component: 'video', filename: 'corrupt.mp4', needThumbnail: true, needVideo: true }, samples.file('corrupt.mp4'), directory, new AbortController().signal, () => {}), /failed/);
});

test('benchmark fixtures generate only their two inputs with network access disabled', { skip: process.env.MEDIA_TESTS !== '1', timeout: 120_000 }, async t => {
  const settings = await localSettings();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-offline-fixtures-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network access disabled'); };
  try { await fixtures(settings, directory, 'benchmark'); }
  finally { globalThis.fetch = original; }
  assert.deepEqual((await readdir(directory)).sort(), ['photo.png', 'video.mp4']);
});

test('reserved color-space metadata is corrected before decoding only on the selected movie stream', () => {
  const movie = { index: 2, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, color_space: 'reserved', color_primaries: 'bt709' };
  const info = parseVideoInfo({ streams: [
    { index: 0, codec_type: 'video', width: 300, height: 300, disposition: { attached_pic: 1 } }, movie
  ] });
  assert.deepEqual(videoInputArgs('in.mp4', info), ['-bsf:2', 'h264_metadata=matrix_coefficients=1', '-i', 'in.mp4']);
  for (const mode of ['cuda', 'nvenc', 'software'] as const) {
    const args = videoArgs('in.mp4', 'out.mp4', info, defaults, mode);
    assert.ok(args.indexOf('-bsf:2') < args.indexOf('-i'));
    assert.equal(args[args.indexOf('-bsf:2') + 1], 'h264_metadata=matrix_coefficients=1');
  }
  const hdr = parseVideoInfo({ streams: [{ ...movie, codec_name: 'hevc', color_primaries: 'bt2020', color_transfer: 'smpte2084' }] });
  assert.equal(hdr.hdr, true);
  assert.equal(hdr.inputBitstreamFilter, 'hevc_metadata=matrix_coefficients=9');
  assert.equal(parseVideoInfo({ streams: [{ ...movie, color_primaries: undefined }] }).inputBitstreamFilter, 'h264_metadata=matrix_coefficients=2');
  for (const color_space of ['bt709', 'bt2020nc', 'unknown', undefined]) {
    assert.deepEqual(videoInputArgs('in.mp4', parseVideoInfo({ streams: [{ ...movie, color_space }] })), ['-i', 'in.mp4']);
  }
  assert.equal(parseVideoInfo({ streams: [{ ...movie, codec_name: 'vp9' }] }).inputBitstreamFilter, undefined);
});

test('real reserved color-space videos generate thumbnails and previews without changing originals or valid color tags', { skip: process.env.MEDIA_TESTS !== '1', timeout: 120_000 }, async t => {
  const settings = await localSettings(), hardware = await inspectHardware(settings);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-reserved-color-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const probe = async (filename: string) => JSON.parse(await command(settings.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename]));
  const hash = async (filename: string) => createHash('sha256').update(await readFile(filename)).digest('hex');
  for (const [codec, range, hdr] of [['h264', 'tv', false], ['h264', 'pc', false], ['hevc', 'tv', true]] as const) {
    await t.test(`${codec} ${range}${hdr ? ' HDR' : ''}`, async () => {
      const outputDirectory = await mkdtemp(path.join(directory, 'item-'));
      const original = path.join(outputDirectory, 'original.mp4'), source = path.join(outputDirectory, 'reserved.mp4');
      await command(settings.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.3',
        '-c:v', codec === 'h264' ? 'libx264' : 'libx265', '-threads', '2', '-preset', 'ultrafast',
        ...(codec === 'hevc' ? ['-x265-params', 'pools=2:frame-threads=1:log-level=error'] : []),
        '-pix_fmt', hdr ? 'yuv420p10le' : 'yuv420p', '-color_range', range,
        '-color_primaries', hdr ? 'bt2020' : 'bt709', '-color_trc', hdr ? 'smpte2084' : 'bt709', '-colorspace', hdr ? 'bt2020nc' : 'bt709',
        '-c:a', 'aac', original]);
      await command(settings.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', original, '-map', '0', '-c', 'copy',
        '-bsf:v', `${codec}_metadata=matrix_coefficients=3`, source]);
      const before = await probe(source), digest = await hash(source);
      assert.equal(before.streams[0].color_space, 'reserved');
      assert.equal(before.streams[0].color_range, range);
      // FFmpeg's full-range yuvj formats bypass this metadata validation.
      if (range === 'tv') await assert.rejects(command(settings.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', source, '-frames:v', '1', '-vf', 'scale=160:90', '-f', 'null', '-']), /Invalid color (?:range|space)/);
      const item: MediaItem = { key: 'reserved', unitId: 1, space: 'personal', component: 'video', filename: 'reserved.mp4', needThumbnail: true, needVideo: true };
      // Verify the CPU path even on machines with an NVIDIA GPU.
      const outputs = await new MediaConverter(settings, { ...hardware, nvenc: false }).convert(item, source, outputDirectory, new AbortController().signal, () => {});
      assert.deepEqual(Object.keys(outputs).sort(), ['film_h264', 'thumb_m', 'thumb_sm', 'thumb_xl']);
      for (const output of Object.values(outputs)) assert.ok((await stat(output)).size > 0);
      const result = await probe(outputs.film_h264), video = result.streams.find((s: any) => s.codec_type === 'video');
      assert.equal(video.codec_name, 'h264');
      // Compare with a correctly tagged source through the same preview pipeline,
      // which can convert full-range pixels and change the output color tags.
      const reference = path.join(outputDirectory, 'reference.mp4');
      await command(settings.ffmpeg, videoArgs(original, reference, parseVideoInfo(await probe(original)), settings, 'software'));
      const referenceVideo = (await probe(reference)).streams.find((s: any) => s.codec_type === 'video');
      for (const tag of ['color_range', 'color_space', 'color_transfer', 'color_primaries']) assert.equal(video[tag], referenceVideo[tag]);
      assert.notEqual(video.color_space, 'reserved');
      assert.ok(result.streams.some((s: any) => s.codec_type === 'audio' && s.codec_name === 'aac'));
      assert.equal(await hash(source), digest);
      await command(settings.ffmpeg, ['-v', 'error', '-xerror', '-i', outputs.film_h264, '-f', 'null', '-']);
      // Also verify accelerated backends where the installed tools support them.
      if (hardware.nvenc) {
        const info = parseVideoInfo(before);
        for (const mode of hardware.cudaScale && !hdr ? ['cuda', 'nvenc'] as const : ['nvenc'] as const) {
          const destination = path.join(outputDirectory, `${mode}.mp4`);
          await command(settings.ffmpeg, videoArgs(source, destination, info, settings, mode));
          const accelerated = (await probe(destination)).streams.find((s: any) => s.codec_type === 'video');
          assert.equal(accelerated.codec_name, 'h264');
          assert.notEqual(accelerated.color_space, 'reserved');
          if (hdr) assert.equal(accelerated.color_transfer, 'bt709');
          await command(settings.ffmpeg, ['-v', 'error', '-xerror', '-i', destination, '-f', 'null', '-']);
        }
      }
    });
  }
});
test('image cache memory scales with hardware while preserving system headroom', () => {
  assert.equal(imageCacheEnvironment(128, 32).MAGICK_MEMORY_LIMIT, '992MiB');
  assert.equal(imageCacheEnvironment(32, 16).MAGICK_MEMORY_LIMIT, '448MiB');
  assert.equal(imageCacheEnvironment(8, 32).MAGICK_MEMORY_LIMIT, '256MiB');
  assert.equal(imageCacheEnvironment(512, 1).MAGICK_MEMORY_LIMIT, '1024MiB');
});

test('48-megapixel RGB photos generate all three thumbnails', { skip: process.env.MEDIA_TESTS !== '1', timeout: 120_000 }, async t => {
  const settings = await localSettings(), hardware = await inspectHardware(settings);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-large-photo-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'large.png');
  // Q16 RGB pixels alone exceed the converter's 256 MiB memory allowance.
  await command(settings.magick, ['-size', '8064x6048', 'gradient:#173b58-#eba980', `PNG24:${source}`]);
  const item: MediaItem = { key: 'large-photo', unitId: 1, space: 'personal', component: 'photo', filename: 'large.png', needThumbnail: true, needVideo: false };
  const outputs = await new MediaConverter(settings, hardware).convert(item, source, directory, new AbortController().signal, () => {});
  assert.equal(Object.keys(outputs).length, 3);
  for (const [key, output] of Object.entries(outputs)) {
    assert.ok((await stat(output)).size > 0);
    const dimensions = (await command(settings.magick, ['identify', '-format', '%w %h', output])).split(' ').map(Number);
    assert.equal(Math.min(...dimensions), { thumb_sm: 240, thumb_m: 320, thumb_xl: 1280 }[key]);
  }
});
