# Synology Preview Studio

Synology Preview Studio uses a Windows desktop to generate missing thumbnails and video previews for Synology Photos. It downloads only the media that Synology reports as needing conversion, processes it locally, uploads the generated previews, and removes the temporary files.

The application is useful when preview generation on the NAS is slow, incomplete, or unable to handle formats such as HEIC, HEVC, and HDR video efficiently.

> [!IMPORTANT]
> This project uses Synology Photos web APIs that Synology does not publicly document as a stable integration surface. DSM or Synology Photos updates may change their behavior.

## What it does

- Works with Personal Space, Shared Space, or both when the NAS advertises the required APIs.
- Generates three image thumbnails with ImageMagick.
- Extracts video thumbnails and, when requested by the NAS, generates a 720p H.264/AAC preview with FFmpeg.
- Uses NVIDIA decoding, scaling, and NVENC encoding when the media and installed FFmpeg build support it.
- Tone maps HDR10 and HLG video to BT.709 for compatible previews.
- Keeps download, image, video, and upload concurrency independent.
- Continually refills the work queue while current files are processing.
- Starts video work before photos so long MOV files are less likely to become the tail of a batch.
- Deduplicates NAS items within a run by space, unit ID, and component.
- Supports pause, resume, stop, failed-item retry, two-factor authentication, and live progress updates.

Original media is never modified. Generated previews are uploaded through Synology Photos' converted-file API.

## Requirements

- Windows 10 or Windows 11
- Node.js 24 or newer
- FFmpeg and FFprobe available on `PATH`, or their executable paths configured in the UI
- ImageMagick 7 with HEIC/HEIF reading support
- A Synology Photos account with access to the selected spaces
- A trusted HTTPS certificate when connecting to the NAS over HTTPS

An NVIDIA GPU is optional. Without NVENC, video encoding falls back to `libx264` on the CPU. HEIC support is still required even when a GPU is available.

The application checks FFmpeg, FFprobe, ImageMagick, HEIC support, NVENC, CUDA scaling, and HDR filters when it starts and whenever settings are saved.

## Install and run

From PowerShell in the project directory:

```powershell
npm install
npm run build
npm start
```

Open <http://127.0.0.1:4177>.

On Windows, `start.cmd` performs the build when `dist/index.html` is missing and then starts the server:

```powershell
.\start.cmd
```

Only one application server should run at a time. Settings changes and application updates take effect on the next run or after restarting the server, depending on the change.

## Using the application

1. Enter the base NAS address, such as `https://nas.example.com:5001`. Do not include a path, query string, or credentials.
2. Enter the Synology username and password. If two-factor authentication is enabled, submit the current code when requested.
3. Select Personal Space, Shared Space, or both.
4. Click **Execute now**.
5. Leave the server running until the queue completes, or use **Pause** or **Stop**.

Pause prevents new downloads from starting. Files already admitted to the pipeline can continue through conversion and upload. Stop cancels active work; previews whose uploads were already acknowledged remain on the NAS.

If the application or computer restarts, unfinished items can be returned by the NAS and processed again. Successfully acknowledged items normally disappear from the NAS work queue.

## How the queue works

Synology Photos exposes a conversion work queue, not a reliable backlog count or conventional paginated list. The application calls `list_convert_needed` for the Windows preview preset. Synology chooses which pending items to return and may return fewer items than the requested limit.

After a preview upload succeeds, Synology removes that work from its pending set. Later queue requests can then expose more items. Consequently:

- The displayed total grows as new work becomes visible.
- There is no verified full-backlog number before processing.
- The application does not use an offset because affected Photos versions repeat items instead of returning a dependable next page.
- **Current batch dates** shows the date range of the newest group added to the queue. It changes as Synology exposes more work.
- A slow file can briefly be the only visible item. The application checks again every two seconds and starts newly exposed work without another click.

Items are deduplicated during a run using `space:unitId:component`. Identical filenames can still represent different NAS library items and are therefore processed separately.

## Video processing

For a video, Synology can request two different outputs:

- Still thumbnails, generated from an early video frame.
- A complete H.264 preview named `film_h264`, generated when the NAS reports `need_video`.

This is why some MOV files require decoding the whole video rather than extracting only one frame. Skipping the requested H.264 preview would leave the item in Synology's conversion queue.

The selected backend appears below each active filename:

- **NVIDIA decode / scale / encode**: the video stays on the GPU for the main pipeline.
- **nvenc** or **CPU decode · NVIDIA encode**: FFmpeg decodes or filters on the CPU and uses NVENC for H.264 encoding.
- **CPU · H.264**: FFmpeg uses `libx264`.

Rotated or HDR MOV files may still use substantial CPU time even when the UI shows NVENC. The installed FFmpeg build can use NVENC for encoding while rotation, HDR conversion, or tone mapping remains on the CPU. HDR frames are resized before the expensive floating-point tone map to reduce that cost.

The scheduler starts video items before photos and sorts by source size when Synology supplies it. This gives long videos more time to complete while photo workers remain busy.

## Performance settings

Open **Performance & tools** to change settings. Changes apply to the next run.

| Setting | Default | Purpose |
| --- | ---: | --- |
| Download workers | 4 | Concurrent original-media downloads |
| Image workers | 16 | Concurrent ImageMagick conversions |
| Video workers | 4 | Concurrent video conversions, up to 8 |
| Upload workers | 2 | Concurrent preview uploads |
| CPU threads per conversion | 2 | FFmpeg threads allocated to each CPU-assisted conversion |
| Video CQ | 23 | H.264 quality; lower values increase quality and output size |
| Keep free on disk | 10 GiB | Minimum free space preserved on the temporary drive |
| Staged storage limit | 20 GiB | Maximum temporary storage reserved by active files |

Good values depend on NAS bandwidth, disk speed, CPU, GPU, and media mix. Increase one limit at a time and watch files per minute rather than individual-file speed.

For a machine with many CPU cores and an NVIDIA GPU, start with:

- 6–8 download workers
- 16–24 image workers
- 4–8 video workers
- 2–4 upload workers
- 4 CPU threads per conversion

More video workers do not necessarily improve HDR throughput because several conversions can compete for CPU tone-mapping capacity. More download workers also divide the staged-storage budget into smaller reservations when Synology does not report a source size.

### Benchmarking

Run the included conversion benchmark with generated fixtures:

```powershell
npm run benchmark
```

Or benchmark a folder containing both photos and videos:

```powershell
npm run benchmark -- "D:\path\to\media"
```

Results are written to `.benchmarks/latest.json`. The benchmark does not change application settings.

## Temporary storage

Temporary files use `.data/work` unless **Temporary directory** is configured. Each item receives an isolated directory that is deleted after upload, failure, or cancellation.

When Synology supplies a source size, the application reserves approximately twice that size plus 128 MiB. If the size is absent, it divides the staged-storage budget among the configured download workers.

If you see:

> Media exceeds its temporary-disk reservation.

increase **Staged storage limit**, reduce **Download workers**, or both. Also make sure the temporary drive has more free space than **Keep free on disk** plus the active reservations.

## Security and local data

- The web server listens only on `127.0.0.1`.
- State-changing requests require a per-process token and a permitted local origin.
- Redirects from the configured NAS address are disabled.
- Passwords, session IDs, device IDs, and Synology tokens remain in server memory and are cleared on logout or shutdown.
- The NAS address, username, preferences, and recent run summaries are stored under `.data`.
- Original media and generated previews exist temporarily under the configured work directory.

The runtime connects to the configured NAS. Test fixture generation may download the public libheif example image when the optional real-media test suite is enabled.

## Troubleshooting

### A MOV file takes a long time

Check the backend shown in the active-file table. `nvenc` confirms GPU encoding, but HDR tone mapping or rotation can still run on the CPU. Long, 4K, 60 fps, 10-bit, or HDR videos naturally take longer because Synology requested a complete video preview.

Video-first scheduling prevents these files from starting at the end of a newly exposed group. Photos continue on separate image workers whenever Synology has made them visible.

### The total stops with one or two MOV files remaining

The NAS may temporarily expose only those remaining items. The application polls every two seconds. When their uploads cause Synology to expose more work, the total increases and processing continues automatically.

### Two FFmpeg processes appear for one file

Chocolatey's `ffmpeg.exe` shim can appear as a parent process that launches the real FFmpeg executable. This is one conversion. Inside the application, a NAS item key is scheduled only once per run.

### An item appears to be processed again

An interrupted conversion or an upload without a confirmed acknowledgment remains pending on the NAS and can be returned after restart. The application deliberately retries it rather than assuming an incomplete preview is valid. Files with the same name but different Synology unit IDs are distinct items.

### Shared Space is unavailable

The account needs Shared Space access, and the installed Synology Photos version must advertise the separate `SYNO.FotoTeam` download and converted-file APIs.

### HTTPS certificate is not trusted

Use a NAS hostname with a certificate trusted by Windows. The application does not disable TLS verification.

### Live Photo video component error

Separate `live_video` conversion components are rejected because their download and upload contract has not been verified for all supported Photos versions. Regular photos and videos continue to use their verified routes.

## Development

```powershell
npm run check
npm test
npm run test:browser
npm run build
```

Run the optional real FFmpeg and ImageMagick integration tests from PowerShell with:

```powershell
$env:MEDIA_TESTS = '1'
npm test
```

The source layout is:

- `client/`: React interface
- `server/`: local server, Synology client, scheduler, and media conversion
- `shared/`: shared TypeScript types
- `scripts/`: fixture generation and benchmarks
- `test/`: unit, integration, and Playwright tests
