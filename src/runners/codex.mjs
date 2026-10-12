// Codex: prompt on stdin, a read-only sandbox (it cannot turn reads off), no saved session; the last message goes to a file.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const tools = 'read-only';
export const login = (env) => ({ files: [join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')], vars: ['OPENAI_API_KEY', 'CODEX_API_KEY'] });
const outFile = (dir, step) => join(dir, `out-${step}.txt`);
export const command = ({ model, dir, step, extra }) => ({
  args: ['exec', ...(model ? ['-m', model] : []), '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', ...extra, '-o', outFile(dir, step), '-'],
  stdin: true,
  outputs: [`out-${step}.txt`],
});
export const answer = (out, { dir, step }) => (existsSync(outFile(dir, step)) ? { text: readFileSync(outFile(dir, step), 'utf8') } : {});
