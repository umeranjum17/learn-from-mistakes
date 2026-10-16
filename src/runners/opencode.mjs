// OpenCode: the prompt is the one attached file; every permission is denied through the env (its plan agent is not read-only).
// It saves the session; later retros skip it by the marker on the message and the .lfm/ run dir.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const tools = 'off';
export const login = (env) => ({ files: [join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'auth.json')], vars: [] });
export const skills = (env) => join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'skills');
// Counts the stored credentials and the provider keys set in the environment; only the counts are read. A custom provider
// can keep its key in the environment (`{env:VAR}` in the opencode config) and store no credential, so the configured
// model's provider is looked up too: its variable set counts as logged in, and the model itself is never called.
export const loginStatus = (model, dir) => {
  const id = model?.includes('/') ? model.split('/')[0] : '';
  const envKey = () => {
    if (!id) return null;
    for (const f of [join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'opencode.json'), join(dir ?? '.', 'opencode.json')]) {
      let provider; try { provider = JSON.parse(readFileSync(f, 'utf8'))?.provider?.[id]; } catch { continue; }
      const key = provider && /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/.exec(JSON.stringify(provider));
      if (key && process.env[key[1]]) return { key: key[1], from: f };
    }
    return null;
  };
  const from = envKey();
  return { args: ['auth', 'list'], ok: (r) => /\b[1-9]\d* (credentials?|environment variables?)\b/.test(r.stdout) || Boolean(from),
    ...(from && { note: `provider ${id} key from env ${from.key} (${from.from})` }), fix: 'opencode auth login' };
};
// `--` ends the -f file list, which would otherwise take the message as a second file.
export const command = ({ model, effort, dir, prompt, marker, extra }) => ({
  args: ['run', ...(model ? ['-m', model] : []), ...(effort ? ['--variant', effort] : []), '--format', 'json', '--dir', dir, '-f', prompt, ...extra, '--', `${marker} Follow the instructions in the attached file.`],
  env: { OPENCODE_PERMISSION: '{"*":"deny"}' },
});
// JSON lines; the answer is the last text part, an error event carries the agent's own cause. Each step_finish part
// counts its step's tokens (input with the cached ones, output with reasoning) and reports why its step finished; the
// last one's reason is the answer's stop (a length cut reads "length"), which apply refuses.
export function answer(out) {
  let text, error, session_id, tokens, stop;
  for (const line of out.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    session_id ??= e?.sessionID;
    if (e?.type === 'text') text = e.part?.text;
    if (e?.type === 'error') error ??= e.error?.data?.message || e.error?.name || 'unknown error';
    const t = e?.type === 'step_finish' && e.part?.tokens;
    if (t) { tokens = { tokens_in: (tokens?.tokens_in ?? 0) + (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0), tokens_out: (tokens?.tokens_out ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) }; stop = e.part?.reason ?? stop; }
  }
  return error ? { error } : { text, session_id, stop: stop ?? null, ...tokens };
}
