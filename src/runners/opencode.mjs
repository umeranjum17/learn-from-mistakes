// OpenCode: the prompt is the one attached file; every permission is denied through the env (its plan agent is not read-only).
// It saves the session; later retros skip it by the marker on the message and the .lfm/ run dir.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const tools = 'off';
export const login = (env) => ({ files: [join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'auth.json')], vars: [] });
export const skills = (env) => join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'skills');
// Counts the stored credentials and the provider keys set in the environment; only the counts are read.
export const loginStatus = () => ({ args: ['auth', 'list'], ok: (r) => /\b[1-9]\d* (credentials?|environment variables?)\b/.test(r.stdout), fix: 'opencode auth login' });
// `--` ends the -f file list, which would otherwise take the message as a second file.
export const command = ({ model, effort, dir, prompt, marker, extra }) => ({
  args: ['run', ...(model ? ['-m', model] : []), ...(effort ? ['--variant', effort] : []), '--format', 'json', '--dir', dir, '-f', prompt, ...extra, '--', `${marker} Follow the instructions in the attached file.`],
  env: { OPENCODE_PERMISSION: '{"*":"deny"}' },
});
// JSON lines; the answer is the last text part, an error event carries the agent's own cause.
export function answer(out) {
  let text, error;
  for (const line of out.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === 'text') text = e.part?.text;
    if (e?.type === 'error') error ??= e.error?.data?.message || e.error?.name || 'unknown error';
  }
  return error ? { error } : { text };
}
