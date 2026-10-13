// Claude Code: prompt on stdin, no tools, no saved session, no MCP servers. Not --bare: it never reads an OAuth login.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const tools = 'off';
export const login = (env) => ({ files: [join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json')], vars: ['ANTHROPIC_API_KEY'] });
export const skills = (env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills');
export const command = ({ model, effort, extra }) => ({
  args: ['-p', '--output-format', 'json', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), '--tools', '', '--no-session-persistence', '--strict-mcp-config', ...extra],
  stdin: true,
});
// One JSON result object; on a failure (exit 1) it still holds the agent's own error in `result`. Input tokens count the
// cached ones too.
export function answer(out) {
  let r;
  try { r = JSON.parse(out); } catch { return {}; }
  if (r?.is_error) return { error: String(r.result || 'is_error with no message') };
  const u = r?.usage;
  return { text: r?.result, session_id: r?.session_id, ...(u && { tokens_in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), tokens_out: u.output_tokens }) };
}
