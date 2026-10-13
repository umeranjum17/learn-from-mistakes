// A process's start time tells it from a later process with the same pid; null when there is no such process.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export function startTime(pid) {
  try {
    if (!existsSync('/proc/self/stat')) return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' '); // after "pid (comm) "
    return f[0] === 'Z' ? null : f[19]; // field 22, starttime; a zombie has already ended
  } catch { return null; }
}
