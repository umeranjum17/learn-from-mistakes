// Pi: prompt on stdin, no tools, no saved session, no context files, skills or extensions.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const tools = 'off';
export const login = (env) => ({ files: [join(env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'auth.json')], vars: [] });
export const command = ({ model, extra }) => ({
  args: ['-p', ...(model ? ['--model', model] : []), '--mode', 'json', '--no-session', '--no-tools', '--no-context-files', '--no-skills', '--no-extensions', ...extra],
  stdin: true,
});
// JSON lines; the answer is the last assistant message. A failed call still exits 0, with its cause in errorMessage.
export function answer(out) {
  let m;
  for (const line of out.split('\n')) {
    try { const e = JSON.parse(line); if (e?.type === 'message_end' && e.message?.role === 'assistant') m = e.message; } catch { /* not an event */ }
  }
  if (m?.stopReason === 'error') return { error: String(m.errorMessage || 'error with no message') };
  return { text: m?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('') };
}
