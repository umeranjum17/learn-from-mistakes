// The poll guard's hook: a Claude Code PreToolUse hook that blocks the third identical poll-like Bash command in one
// context, with one line that says what to do instead. A context is the session since its last compaction, and any
// other work between (an edit, or a Bash command that is not a poll) starts the count again. It is append-only and
// fail-open: it never rewrites earlier context, and any error lets the call through. Its state is one small file per
// session under $LFM_HOME/tokens/guard, keyed by a hash of the command, never its text; each block is logged in
// fired.jsonl there. The hook runs this file directly on every Bash call, so it imports only node and redact.mjs.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { excerpt } from '../redact.mjs';

// A command that waits on or re-reads some state: sleep, status, inbox, tail, checks, pgrep, wait, watch, ps or ls.
const POLL = /\b(?:sleep|status|inbox|tail|checks|pgrep|wait|watch)\b|(?:^|[\s;&|(])(?:ps|ls)(?:\s|$)/;
export const pollKey = (command) => { const c = String(command ?? '').trim().replace(/\s+/g, ' '); return c && POLL.test(c) ? c : null; };
// A tool call that changes files: work, so the polls before it are not repeats of the ones after it.
export const WORK = /^(?:Edit|Write|MultiEdit|NotebookEdit|edit|write)$/;
export const BASH = /^(?:Bash|bash)$/;
export const MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit';
const LIMIT = 3; // the run of identical polls the guard blocks at
export const guardDir = () => join(process.env.LFM_HOME || join(homedir(), '.learn-from-mistakes'), 'tokens', 'guard'); // $LFM_HOME as config.mjs reads it
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const message = (n) => `poll guard: this same command already ran ${n} times in this context with no other work between, and each run re-reads the whole context; wait on an event instead (a background job or monitor that ends when the state changes), or run a different command.`;

// The hook payload on stdin. It prints only a deny decision, and never fails.
export function guard() {
  try {
    if (process.stdin.isTTY) return; // run by hand: no payload
    const p = JSON.parse(readFileSync(0, 'utf8'));
    const session = p?.session_id;
    if (typeof session !== 'string' || !/^[\w.-]{1,128}$/.test(session) || session.startsWith('.')) return;
    const dir = guardDir(), file = join(dir, `${session}.json`);
    if (p.hook_event_name === 'SessionStart') { rmSync(file, { force: true }); return; } // a compaction starts a new context
    if (p.hook_event_name !== 'PreToolUse') return;
    const key = BASH.test(p.tool_name) ? pollKey(p.tool_input?.command) : null;
    if (!key) { if (BASH.test(p.tool_name) || WORK.test(p.tool_name)) rmSync(file, { force: true }); return; }
    let counts = {};
    try { counts = JSON.parse(readFileSync(file, 'utf8')).counts ?? {}; } catch { /* no run of polls yet */ }
    const h = hash(key), n = (counts[h] ?? 0) + 1;
    counts[h] = n;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.${process.pid}`, JSON.stringify({ counts }));
    renameSync(`${file}.${process.pid}`, file);
    if (n < LIMIT) return;
    appendFileSync(join(dir, 'fired.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), session, repeats: n - 1, command: excerpt(key).slice(0, 80) })}\n`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message(n - 1) } }));
  } catch { /* fail-open: the call goes ahead */ }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) guard();
