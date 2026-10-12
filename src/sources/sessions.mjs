// sessions: the coding agent sessions that ran in this project (its dir, a subdir or a git worktree of the repo),
// read from each agent's own store. Store roots come from the agents' env overrides, never from this config.
// The tool's own agent runs are skipped: a cwd under .lfm/, the lfm-run: marker, or a session id the run store
// recorded. Each event keeps a redacted excerpt of at most 300 characters, or none with `excerpts: off`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { UsageError } from '../../bin/learn-from-mistakes-axi.mjs';
import { mapping } from '../config.mjs';
import { redact } from '../redact.mjs';
import * as claude from '../sessions/claude.mjs';

const READERS = { claude };

export function validate(s, where, dir) {
  mapping(s, ['type', 'agents'], where);
  const agents = s.agents ?? ['auto'];
  if (!Array.isArray(agents) || !agents.length || !agents.every((a) => a === 'auto' || Object.hasOwn(READERS, a))) {
    throw new UsageError(`${where}.agents must be a list of auto or ${Object.keys(READERS).join(', ')}`);
  }
  return { type: s.type, agents: agents.includes('auto') ? Object.keys(READERS) : [...new Set(agents)], dir };
}

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
// The project dir and every worktree of its repo; a dir outside git is its own only root.
function roots(dir) {
  let trees = [];
  try {
    trees = execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  } catch { /* not a git repo */ }
  return [...new Set([dir, ...trees].map(real))];
}

export async function read(source, { agents, dir }, { readFrom = 0, excerpts = true, skip = new Set() } = {}) {
  const rs = roots(dir);
  const keep = (cwd) => rs.some((r) => {
    const rel = cwd === r ? '' : cwd.startsWith(r + sep) ? cwd.slice(r.length + 1) : null;
    return rel !== null && !rel.split(sep).includes('.lfm');
  });
  // The whole text is redacted before the cut, so no secret is split at the edge of the kept part.
  const excerpt = (text) => (excerpts ? redact(text).replace(/\s+/g, ' ').trim().slice(0, 300) : '');
  const out = { events: [], sessions: 0, skipped: 0 };
  for (const a of agents) {
    let got;
    try { got = await READERS[a].read({ readFrom, keep, excerpt, skip }); } catch (e) {
      throw new UsageError(`source ${source}: cannot read a ${a} session (${e.code ?? e.message})`, `chmod -R u+r <the ${a} session store>   # the tool only reads it`);
    }
    out.events.push(...got.events);
    out.sessions += got.sessions;
    out.skipped += got.skipped;
  }
  return { ...out, hash: createHash('sha256').update(JSON.stringify(out.events)).digest('hex') };
}

// Per-session numbers over the events at or after `since` (ms, the run window's start); a session counts when it has
// one of them. n/a, never 0, when there is nothing to divide or count.
export function metrics(events, since) {
  const inWindow = events.filter((e) => Date.parse(e.ts) >= since);
  const count = (f) => inWindow.filter(f).length;
  const sessions = new Set(inWindow.map((e) => e.session_id)).size, results = count((e) => e.kind === 'tool_result');
  const ratio = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : 'n/a');
  return {
    tool_error_rate: ratio(count((e) => e.kind === 'tool_result' && ['tool_error', 'nonzero_exit', 'test_fail'].includes(e.signal)), results),
    corrections_per_session: ratio(count((e) => e.signal === 'correction'), sessions),
    interrupts: sessions ? count((e) => e.signal === 'interrupt') : 'n/a',
    retries: sessions ? count((e) => e.signal === 'retry') : 'n/a',
  };
}

// init: a sessions source when any agent store exists here.
export const detect = () => (Object.values(READERS).some((r) => existsSync(r.root())) ? { type: 'sessions', agents: ['auto'] } : undefined);

// doctor: whether the stores are readable, and the sessions and skipped records in the read range.
export async function doctor(source, entry, ctx) {
  const missing = entry.agents.filter((a) => !existsSync(READERS[a].root()));
  if (missing.length === entry.agents.length) return { level: 'warn', detail: `no ${missing.join(', ')} session store`, fix: 'export CLAUDE_CONFIG_DIR=<your Claude Code config dir>   # if it is not ~/.claude' };
  try {
    const got = await read(source, entry, { ...ctx, excerpts: false });
    return { level: 'ok', detail: `${got.sessions} sessions, ${got.skipped} skipped records` };
  } catch (e) { return { level: 'fail', detail: e.message, fix: e.next }; }
}
