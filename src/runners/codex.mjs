// Codex: prompt on stdin, a read-only sandbox (it cannot turn reads off), no saved session; the last message goes to a file.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const tools = 'read-only';
export const login = (env) => ({ files: [join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')], vars: ['OPENAI_API_KEY', 'CODEX_API_KEY'] });
export const skills = (env) => join(env.CODEX_HOME || join(homedir(), '.codex'), 'skills');
// Exit 0 when logged in; it reads the login and refreshes nothing.
export const loginStatus = () => ({ args: ['login', 'status'], ok: (r) => r.status === 0, fix: 'codex login' });
const outFile = (dir, step) => join(dir, `out-${step}.txt`);
export const command = ({ model, effort, dir, step, extra }) => ({
  args: ['exec', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', ...extra, '-o', outFile(dir, step), '-'],
  stdin: true,
  outputs: [`out-${step}.txt`],
});
export const answer = (out, { dir, step }) => (existsSync(outFile(dir, step)) ? { text: readFileSync(outFile(dir, step), 'utf8') } : {});
