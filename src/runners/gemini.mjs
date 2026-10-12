// Gemini CLI: the bundle on stdin, a short message in -p, the read-only plan mode, no extensions. --skip-trust keeps
// plan mode: in a folder it does not trust, gemini turns any approval mode back to "default". It saves the session;
// later retros skip it by the marker and the .lfm/ run dir.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const tools = 'read-only';
// Not offered as worker or judge until a live write test passes in headless mode; `agents --test gemini` runs that test.
export const unconfirmed = 'not offered: its read-only plan mode is not yet confirmed in headless mode (agents --test gemini runs the write test)';
export const login = (env) => ({ files: [join(env.GEMINI_CLI_HOME || homedir(), '.gemini', 'oauth_creds.json')], vars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] });
export const skills = () => join(homedir(), '.gemini', 'skills');
export const command = ({ model, marker, extra }) => ({
  args: ['-p', `${marker} Follow the instructions above.`, ...(model ? ['-m', model] : []), '-o', 'json', '--approval-mode', 'plan', '--skip-trust', '-e', 'none', ...extra],
  stdin: true,
});
// One JSON object: { response } or { error: { message } }.
export function answer(out) {
  let r;
  try { r = JSON.parse(out.slice(out.indexOf('{'))); } catch { return {}; }
  return r?.error ? { error: String(r.error.message || r.error.type || 'error with no message') } : { text: r?.response };
}
