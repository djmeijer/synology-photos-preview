import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppState, Library, Settings } from '../shared/types.ts';
import './style.css';

const labels: Record<Library, string> = { personal: 'Personal', shared: 'Shared', both: 'Both spaces' };
const number = (value: number) => new Intl.NumberFormat().format(value);
const duration = (seconds: number | null) => seconds == null ? 'Estimating…' : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
const mediaDate = (value: string) => new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [token, setToken] = useState('');
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [otpRequired, setOtpRequired] = useState(false);
  const [library, setLibrary] = useState<Library>('both');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<Settings | null>(null);
  function acceptState(incoming: AppState) {
    setState(current => !current || incoming.serverId !== current.serverId || incoming.revision >= current.revision ? incoming : current);
  }
  useEffect(() => {
    let alive = true;
    const events = new EventSource('/api/events');
    const bootstrap = () => fetch('/api/state').then(async response => {
      if (!response.ok) throw new Error('Cannot connect to the desktop server.');
      const result = await response.json();
      if (alive) { setToken(result.csrfToken); acceptState(result); }
    }).catch(e => { if (alive) setError(e.message); });
    events.onopen = () => { setOnline(true); void bootstrap(); };
    events.onerror = () => setOnline(false);
    events.onmessage = event => { if (alive) acceptState(JSON.parse(event.data)); };
    fetch('/api/state').then(async response => {
      if (!response.ok) throw new Error('Cannot connect to the desktop server.');
      const result = await response.json();
      if (alive) { setToken(result.csrfToken); setLibrary(result.settings.library); acceptState(result); }
    }).catch(e => setError(e.message));
    return () => { alive = false; events.close(); };
  }, []);
  async function action(endpoint: string, body: unknown = {}) {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Preview-Token': token }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) { setOtpRequired(!!data.otpRequired); throw new Error(data.error); }
      acceptState(data); return true;
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); return false; }
    finally { setBusy(false); }
  }
  if (!state) return <main><h1>Synology Preview Studio</h1><p role="status">{error || 'Connecting to the desktop server…'}</p></main>;
  const job = state.job;
  const active = !!job && ['running', 'paused', 'stopping'].includes(job.status);
  const blocked = busy || state.starting || state.finalizing || !online;
  const hardware = state.hardware;
  return <main>
    <header><div><p className="eyebrow">DESKTOP PROCESSING · SYNOLOGY PHOTOS</p><h1>Preview Studio</h1><p className="muted">Fill the gaps in your photo library.</p></div><div className="header-actions"><span className={`connection ${online ? 'online' : ''}`}>{online ? 'Desktop connected' : 'Reconnecting…'}</span><button onClick={() => { setDraft(state.settings); setSettingsOpen(!settingsOpen); }} disabled={busy}>Performance & tools</button></div></header>
    {error && <div className="notice error" role="alert">{error}<button className="quiet" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {settingsOpen && draft && <section className="panel"><h2>Performance & tools</h2><p className="muted">Settings apply to the next run. Hardware checks run again when you save.</p><form onSubmit={async event => { event.preventDefault(); if (await action('settings', draft)) setSettingsOpen(false); }}>
      <div className="settings-grid">{(['downloads', 'images', 'videos', 'uploads', 'softwareThreads', 'cq', 'diskReserveGiB', 'maxStagedGiB'] as const).map(key => <label key={key}>{({ downloads: 'Download workers', images: 'Image workers', videos: 'Video workers', uploads: 'Upload workers', softwareThreads: 'CPU threads per conversion', cq: 'Video CQ (lower = higher quality)', diskReserveGiB: 'Keep free on disk (GiB)', maxStagedGiB: 'Staged storage limit (GiB)' })[key]}<input type="number" min={key === 'cq' ? 15 : 1} max={{ downloads: 16, images: 32, videos: 8, uploads: 8, softwareThreads: 8, cq: 35, diskReserveGiB: 1000, maxStagedGiB: 1000 }[key]} value={draft[key]} onChange={e => setDraft({ ...draft, [key]: Number(e.target.value) })} required /></label>)}</div>
      <div className="settings-grid tools">{(['ffmpeg', 'ffprobe', 'magick', 'tempDirectory'] as const).map(key => <label key={key}>{({ ffmpeg: 'FFmpeg executable', ffprobe: 'FFprobe executable', magick: 'ImageMagick executable', tempDirectory: 'Temporary directory (blank = app storage)' })[key]}<input value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })} required={key !== 'tempDirectory'} /></label>)}</div>
      <button className="primary" disabled={blocked || active}>Save & check hardware</button></form></section>}
    <section className="panel"><h2><span className="step">01</span> NAS connection</h2>
      {state.connection.connected ? <><p className="connected-nas">Connected as <strong>{state.connection.username}</strong></p><p className="muted break">{state.connection.url}</p><div className="tags">{state.connection.spaces.map(space => <span key={space}>{labels[space]} available</span>)}</div><button disabled={blocked || active} onClick={() => void action('disconnect')}>Disconnect</button></>
        : <form onSubmit={async event => {
          event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
          const password = form.elements.namedItem('password') as HTMLInputElement;
          const otp = form.elements.namedItem('otp') as HTMLInputElement;
          const payload = { url: data.get('url'), username: data.get('username'), password: data.get('password'), otp: data.get('otp') };
          // Clear secrets from the DOM as soon as the request is sent. They are never put in React state or storage.
          password.value = ''; otp.value = '';
          if (await action('connect', payload)) setOtpRequired(false);
        }}><label>NAS address<input name="url" type="url" defaultValue={state.settings.nasUrl} placeholder="https://nas.example.com:5001" required autoComplete="url" /></label><label>Username<input name="username" defaultValue={state.settings.username} required autoComplete="username" /></label><div className="credential-grid"><label>Password<input name="password" type="password" required autoComplete="off" /></label><label>{otpRequired ? 'Two-factor code required' : 'Two-factor code (optional)'}<input name="otp" inputMode="numeric" autoComplete="off" required={otpRequired} /></label></div><button className="primary" disabled={blocked || !token}>Connect to NAS</button><p className="fine">Password and session tokens stay in server memory. Only address, username, and preferences are remembered.</p>{otpRequired && <p role="status">Enter your password again with the current two-factor code.</p>}</form>}
    </section>
    <section className="panel"><div className="section-heading"><h2><span className="step">02</span> Generate previews</h2><div className="actions"><button className="primary" disabled={blocked || active || !state.connection.connected} onClick={() => void action('jobs', { library })}>{state.starting ? 'Fetching batch…' : state.finalizing ? 'Fetching next batch…' : 'Execute now'}</button><button disabled={blocked || job?.status !== 'running'} onClick={() => void action('jobs/pause')}>Pause</button><button disabled={blocked || job?.status !== 'paused'} onClick={() => void action('jobs/resume')}>Resume</button><button className="danger" disabled={busy || !active || job?.status === 'stopping'} onClick={() => void action('jobs/stop')}>Stop</button><button disabled={blocked || active || !job?.failed || !state.connection.connected} onClick={() => void action('jobs', { retryFailed: true })}>Retry failed</button></div></div>
      <label>Space<select aria-label="Space" value={library} disabled={active || blocked} onChange={e => setLibrary(e.target.value as Library)}><option value="personal">Personal</option><option value="shared">Shared</option><option value="both">Both spaces</option></select></label><p className="fine">Execute keeps fetching and processing batches from the selected space until the NAS returns no more pending previews.</p>{state.connection.sharedReason && <p className="fine">{state.connection.sharedReason}</p>}
      {job?.mediaDateFrom && job.mediaDateTo && <p className="fine"><strong>Current batch dates:</strong> {mediaDate(job.mediaDateFrom)}{mediaDate(job.mediaDateFrom) !== mediaDate(job.mediaDateTo) && ` – ${mediaDate(job.mediaDateTo)}`}</p>}
      {job ? <><div className="progress-caption"><span className="tags"><span>{job.status.replaceAll('_', ' ')} · {labels[job.library]}</span></span><span>{number(job.success + job.failed + job.cancelled)} / {number(job.total)} files settled in this batch</span></div><div className="progress-track" role="progressbar" aria-label="Files settled" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.settledPercent)}><span className="success-bar" style={{ width: `${job.success / job.total * 100}%` }} /><span className="failure-bar" style={{ width: `${job.failed / job.total * 100}%` }} /><span className="cancel-bar" style={{ width: `${job.cancelled / job.total * 100}%` }} /></div><div className="metrics job-metrics"><div><strong className="good">{number(job.success)}</strong><span>Uploaded successfully</span></div><div><strong className="bad">{number(job.failed)}</strong><span>Failed</span></div><div><strong>{number(job.remaining)}</strong><span>Remaining</span></div><div><strong>{number(job.cancelled)}</strong><span>Cancelled</span></div><div><strong>{job.filesPerMinute.toFixed(1)}</strong><span>Files / minute</span></div><div><strong>{job.mibPerSecond.toFixed(1)}</strong><span>Transfer MiB / second</span></div><div><strong>{active ? duration(job.etaSeconds) : '—'}</strong><span>Estimated remaining</span></div></div>{job.status === 'paused' && <p className="fine">New downloads are paused. Files already downloaded continue through conversion and upload.</p>}{state.finalizing && <p role="status">Cleaning up and fetching the next batch…</p>}{job.verificationError && <div className="notice error" role="alert">Verification: {job.verificationError}</div>}
      {job.active.length > 0 && <div className="table-wrap"><table><thead><tr><th>Active file</th><th>Space</th><th>Stage</th><th>Progress</th></tr></thead><tbody>{job.active.map(item => <tr key={item.key}><td><strong>{item.filename}</strong><small>{item.backend || item.component}</small></td><td>{labels[item.space]}</td><td>{item.stage}</td><td>{item.percent == null ? '—' : `${item.percent.toFixed(0)}%`}</td></tr>)}</tbody></table></div>}
      {job.errors.length > 0 && <details open><summary>{job.failed} failed files retained for retry</summary>{job.errors.map(item => <p className="file-error" key={item.key}><strong>{item.filename}</strong> ({labels[item.space]})<br />{item.error}</p>)}</details>}</> : <p className="empty">Your desktop does the processing. Uploaded results remain on the NAS when you stop.</p>}
      <p className="fine">The work queue refills while current files are still processing, so one slow file does not leave other workers idle. Closing this browser leaves processing active; keep the server window open.</p>
    </section>
    <section className="panel hardware"><h2>Desktop readiness</h2><p>{hardware?.cpu} · {hardware?.logicalCpus} threads · {hardware?.memoryGiB} GiB RAM</p><p className="muted">{hardware?.gpu || 'GPU not detected'}</p><div className="tags">{hardware && (['ffmpeg', 'ffprobe', 'magick', 'heic', 'nvenc', 'cudaScale', 'hdrFilters'] as const).map(key => <span className={hardware[key] ? 'ready' : 'missing'} key={key}>{({ ffmpeg: 'FFmpeg', ffprobe: 'FFprobe', magick: 'ImageMagick', heic: 'HEIC', nvenc: 'NVENC', cudaScale: 'CUDA scaling', hdrFilters: 'HDR → SDR' })[key]} {hardware[key] ? '✓' : 'unavailable'}</span>)}</div>{hardware?.warnings.map(warning => <p className="fine" key={warning}>{warning}</p>)}</section>
    {state.history.length > 0 && <section className="panel"><h2>Previous runs</h2><div className="table-wrap"><table><thead><tr><th>Started</th><th>Library</th><th>Result</th><th>Uploaded / failed / cancelled</th></tr></thead><tbody>{state.history.map(run => <tr key={run.id}><td>{new Date(run.startedAt).toLocaleString()}</td><td>{labels[run.library]}</td><td>{run.status.replaceAll('_', ' ')}</td><td>{run.success} / {run.failed} / {run.cancelled}</td></tr>)}</tbody></table></div><p className="fine">After a server restart, connect and execute again. Previous results contain no passwords or session tokens.</p></section>}
    <footer>Synology Preview Studio · Local desktop app · DSM 7.4.1 / Photos 1.9.1 target</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
