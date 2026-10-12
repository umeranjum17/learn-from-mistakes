// Claude Code: prompt on stdin, no tools, no saved session, no MCP servers. Not --bare: it never reads an OAuth login.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const tools = 'off';
export const login = (env) => ({ files: [join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json')], vars: ['ANTHROPIC_API_KEY'] });
export const skills = (env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills');
export const command = ({ model, extra }) => ({
  args: ['-p', '--output-format', 'json', ...(model ? ['--model', model] : []), '--tools', '', '--no-session-persistence', '--strict-mcp-config', ...extra],
  stdin: true,
});
// One JSON result object; on a failure (exit 1) it still holds the agent's own error in `result`.
export function answer(out) {
  let r;
  try { r = JSON.parse(out); } catch { return {}; }
  return r?.is_error ? { error: String(r.result || 'is_error with no message') } : { text: r?.result };
}
