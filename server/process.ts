import { spawn } from 'node:child_process';
import { AppError } from './errors.ts';
export interface CommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  line?: (line: string) => void;
}
export function command(executable: string, args: string[], options: CommandOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...options.env } });
    let stdout = '', stderr = '', pending = '', finished = false, timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs ?? 30 * 60_000);
    const abort = () => child.kill();
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => {
      stdout = (stdout + data).slice(-1024 * 1024);
      pending += data;
      const lines = pending.split(/\r?\n/); pending = lines.pop() ?? '';
      for (const line of lines) options.line?.(line);
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-16_384); });
    const finish = (error?: Error) => {
      if (finished) return; finished = true;
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(stdout);
    };
    child.on('error', () => finish(new AppError(`Cannot start ${executable}. Check its executable path.`, 409, 'TOOL_ERROR')));
    child.on('close', code => {
      if (options.signal?.aborted) finish(new DOMException('Operation cancelled', 'AbortError'));
      else if (timedOut) finish(new AppError(`${executable} exceeded the conversion timeout.`, 409, 'TOOL_ERROR'));
      else if (code !== 0) finish(new AppError(`${executable} failed: ${stderr.trim().slice(-3000) || `exit code ${code}`}`, 409, 'TOOL_ERROR'));
      else finish();
    });
  });
}
