import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { parseVideoInfo, videoArgs, videoDimensions, softwareFilters, inspectHardware, MediaConverter } from '../server/media.ts';
import { defaults } from '../server/settings.ts';
import { command } from '../server/process.ts';
import { localSettings } from '../scripts/tools.ts';
import { fixtures } from '../scripts/fixtures.ts';
import type { MediaItem } from '../shared/types.ts';

test('rotated, odd, portrait and small video dimensions preserve the aspect ratio without upscaling', () => {
  const info = parseVideoInfo({ streams: [{ codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }], format: { duration: '10' } });
  assert.deepEqual(videoDimensions(info), { width: 720, height: 1280 });
  assert.deepEqual(videoDimensions({ ...info, width: 639, height: 359 }), { width: 638, height: 358 });
  const hdr = videoArgs('in.mp4', 'out.mp4', { ...info, hdr: true }, defaults, 'nvenc');
  assert.ok(hdr.includes('0:a:0?')); assert.ok(hdr.includes('p1')); assert.ok(hdr.includes('23')); assert.ok(hdr.some(x => x.includes('tonemap=')));
  const hdrFilter = softwareFilters({ ...info, hdr: true }, 720, 1280);
  assert.match(hdrFilter, /^zscale=w=720:h=1280:t=linear/);
  assert.doesNotMatch(hdrFilter, /(?:^|,)scale=720:1280/);
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
