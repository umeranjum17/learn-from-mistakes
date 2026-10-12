// sessions: the coding agent sessions that ran in this project (its dir, a subdir or a git worktree of the repo),
// read from each agent's own store. Store roots come from the agents' env overrides, never from this config.
// The tool's own agent runs are skipped: a cwd under .lfm/, the lfm-run: marker, or a session id the run store
// recorded. Each event keeps a redacted excerpt of at most 300 characters, or none with `excerpts: off`, and the
// first cause whose match rule names this source and fits it (signal, tool, and text_contains in the whole text of a signal event).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { UsageError } from '../../bin/learn-from-mistakes-axi.mjs';
import { mapping } from '../config.mjs';
import { inWindow } from '../metrics.mjs';
import { redact } from '../redact.mjs';
import { which } from '../runners/index.mjs';
import * as claude from '../sessions/claude.mjs';
import * as codex from '../sessions/codex.mjs';
import * as opencode from '../sessions/opencode.mjs';

const READERS = { claude, codex, opencode };
export const SIGNALS = ['tool_error', 'nonzero_exit', 'test_fail', 'correction', 'interrupt', 'retry'];

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
  const git = which('git');
  if (git) try {
    trees = execFileSync(git, ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  } catch { /* not a git repo */ }
  return [...new Set([dir, ...trees].map(real))];
}

export async function read(source, { agents, dir }, { readFrom = 0, excerpts = true, skip = new Set(), causes = {} } = {}) {
  const rs = roots(dir);
  const keep = (cwd) => rs.some((r) => {
    const rel = cwd === r ? '' : cwd.startsWith(r + sep) ? cwd.slice(r.length + 1) : null;
    return rel !== null && !rel.split(sep).includes('.lfm');
  });
  const rules = Object.entries(causes).filter(([, c]) => c.match?.source === source).map(([cause, c]) => ({ cause, ...c.match }));
  // A reader keeps what excerpt() returns as the event's excerpt; it is cut and tagged below. text_contains is checked
  // on the whole text, so it also tags with `excerpts: off`. Whitespace is collapsed and the first 4000 characters
  // redacted before the cut, so no secret is split at the edge of the kept part.
  const excerpt = (text) => ({ text: excerpts ? redact(String(text).replace(/\s+/g, ' ').trim().slice(0, 4000)).slice(0, 300) : '',
    hits: rules.filter((m) => m.text_contains && String(text).includes(m.text_contains)).map((m) => m.cause) });
  const out = { events: [], sessions: 0, skipped: 0 };
  for (const a of agents) {
    let got;
    try { got = await READERS[a].read({ readFrom, keep, excerpt, skip }); } catch (e) {
      throw new UsageError(`source ${source}: cannot read a ${a} session store at ${e.path ?? READERS[a].root()}: ${e.code ?? e.message}`, `chmod -R u+r <the ${a} session store>   # the tool only reads it`);
    }
    for (const e of got.events) {
      const x = typeof e.excerpt === 'object' ? e.excerpt : { text: '', hits: [] };
      e.excerpt = x.text;
      e.cause = e.signal ? rules.find((m) => (!m.signal || m.signal === e.signal) && (!m.tool || m.tool === e.tool) && (!m.text_contains || x.hits.includes(m.cause)))?.cause ?? null : null;
      out.events.push(e);
    }
    out.sessions += got.sessions;
    out.skipped += got.skipped;
  }
  return { ...out, hash: createHash('sha256').update(JSON.stringify(out.events)).digest('hex') };
}

// Per-session numbers over the events in the window; a session counts when it has one of them.
// null (n/a), never 0, when there is nothing to divide or count.
export const metricNames = ['tool_error_rate', 'corrections_per_session', 'interrupts', 'retries'];
export const metricRows = 'events';
export function metrics(events, window) {
  const rows = inWindow(events, window);
  const count = (f) => rows.filter(f).length;
  const sessions = new Set(rows.map((e) => e.session_id)).size, results = count((e) => e.kind === 'tool_result');
  const ratio = (n, d) => (d ? n / d : null);
  return {
    tool_error_rate: ratio(count((e) => e.kind === 'tool_result' && ['tool_error', 'nonzero_exit', 'test_fail'].includes(e.signal)), results),
    corrections_per_session: ratio(count((e) => e.signal === 'correction'), sessions),
    interrupts: sessions ? count((e) => e.signal === 'interrupt') : null,
    retries: sessions ? count((e) => e.signal === 'retry') : null,
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
    return { level: 'ok', detail: `${got.sessions} sessions, ${got.skipped} skipped records since ${new Date(ctx.readFrom).toISOString().slice(0, 10)}` };
  } catch (e) { return { level: 'fail', detail: e.message, fix: e.next }; }
}
