// OpenCode sessions: <XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db, and any other *.db there with the same
// tables, each opened read-only. A session runs in session.directory; its messages and their parts hold the turns.
// A subagent session (one with a parent) belongs to the session that started it.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TEST } from './claude.mjs';

export const root = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode');

const json = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// One session's events, message by message and part by part in order. Returns null when the first user message
// carries the lfm-run: marker.
function parse(q, file, { id, session, sub, excerpt }) {
  const events = [], failed = new Set();
  let skipped = 0, first = true, afterError = false, user = false, message;
  for (const row of q.iterate(id)) {
    const m = json(row.m), p = row.p === null ? {} : json(row.p);
    if (!m || typeof m.role !== 'string' || !p) { skipped += 1; continue; }
    const at = { agent: 'opencode', session_id: session, ts: iso(row.t), ref: `${file}:${row.p === null ? `message:${row.mid}` : `part:${row.pid}`}` };
    if (row.mid !== message) { // the message's first part
      message = row.mid;
      user = m.role === 'user' && !sub; // a subagent's user messages come from its parent agent
      // An interrupted reply ends MessageAbortedError; the tools it cut off are not tool failures.
      if (m.error?.name === 'MessageAbortedError') { events.push({ ...at, kind: 'interrupt', signal: 'interrupt', excerpt: '' }); afterError = false; }
    }
    if (p.type === 'text' && !p.synthetic && m.role === 'assistant' && String(p.text).trim()) afterError = false; // a reply ends the adjacency
    if (user && (p.type === 'text' && !p.synthetic && String(p.text).trim() || p.type === 'file')) {
      user = false; // one event per message
      const text = p.type === 'text' ? p.text : '';
      if (first && text.trimStart().startsWith('lfm-run:')) return null; // this tool's own agent session
      first = false;
      // A person's message right after a tool error, with no assistant reply between, corrects the agent.
      events.push({ ...at, kind: afterError ? 'correction' : 'user_msg', signal: afterError ? 'correction' : null, excerpt: afterError ? excerpt(text) : '' });
      afterError = false;
    }
    if (p.type !== 'tool') continue;
    const s = p.state ?? {}, key = `${p.tool}\0${JSON.stringify(s.input)}`;
    const retry = failed.has(key); // the same call again after it failed
    events.push({ ...at, kind: 'tool_call', tool: p.tool, signal: retry ? 'retry' : null, excerpt: retry ? excerpt(JSON.stringify(s.input)) : '' });
    if (!['completed', 'error'].includes(s.status)) continue; // still running when the session was last saved
    const exit = typeof s.metadata?.exit === 'number' ? s.metadata.exit : null;
    const error = s.status === 'error' || Boolean(exit);
    // A call the user turned down or interrupted is not a tool failure; the interrupt or correction after it is counted.
    const declined = s.status === 'error' && /^(?:Tool execution aborted|The user rejected permission)/.test(String(s.error));
    const signal = !error || declined ? null : TEST.test(String(s.input?.command ?? '')) ? 'test_fail' : exit ? 'nonzero_exit' : 'tool_error';
    events.push({ ...at, kind: 'tool_result', tool: p.tool, status: error ? 'error' : 'ok', exit_code: exit, signal, excerpt: signal ? excerpt(s.error ?? s.output ?? '') : '' });
    if (error && !declined) failed.add(key);
    else if (!error) failed.delete(key); // a later repeat is no longer a retry
    afterError ||= error;
  }
  return { events, skipped };
}

// Every session whose directory `keep` accepts and that changed since `readFrom`, from each store file that did.
// `skip` holds session ids this tool started itself.
export async function read({ readFrom, keep, excerpt, skip }) {
  const events = [];
  let sessions = 0, skipped = 0, names;
  try { names = readdirSync(root()).filter((f) => f.endsWith('.db')); } catch (e) { return { events, sessions, skipped: e.code === 'ENOENT' ? 0 : 1 }; }
  const { DatabaseSync } = await import('node:sqlite');
  for (const name of names) {
    const file = join(root(), name);
    if (Math.max(mtime(file), mtime(`${file}-wal`)) < readFrom) continue; // nothing in it changed since
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const tables = db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message', 'part')`).get().n;
      if (tables < 3) continue; // another program's database
      const all = db.prepare('SELECT id, parent_id, directory, time_created, time_updated FROM session').all();
      const byId = new Map(all.map((s) => [s.id, s]));
      const top = (s) => { for (let i = 0; i < 64 && byId.has(s.parent_id); i++) s = byId.get(s.parent_id); return s; };
      const groups = new Map();
      for (const s of all) {
        const t = top(s);
        if (!groups.has(t.id)) groups.set(t.id, []);
        groups.get(t.id).push(s);
      }
      // Parts in order, each with its message; a message with no parts still comes once (its error can be the signal).
      const q = db.prepare(`SELECT m.id AS mid, m.data AS m, p.id AS pid, p.data AS p, COALESCE(p.time_created, m.time_created) AS t
        FROM message m LEFT JOIN part p ON p.message_id = m.id WHERE m.session_id = ? ORDER BY m.time_created, m.id, p.id`);
      for (const [session, members] of groups) {
        const main = byId.get(session);
        if (skip.has(session) || typeof main.directory !== 'string' || !keep(main.directory)) continue;
        if (!members.some((s) => s.time_updated >= readFrom)) continue;
        const got = parse(q, file, { id: session, session, excerpt });
        if (!got) continue;
        sessions += 1;
        events.push({ agent: 'opencode', session_id: session, ts: iso(main.time_created), ref: `${file}:session:${session}`, kind: 'session_start', excerpt: '' }, ...got.events);
        skipped += got.skipped;
        for (const s of members.filter((x) => x !== main && x.time_updated >= readFrom)) {
          const sub = parse(q, file, { id: s.id, session, sub: true, excerpt });
          events.push(...(sub?.events ?? []));
          skipped += sub?.skipped ?? 0;
        }
      }
    } catch (e) { // a store that cannot be opened or read is counted; the others still read
      if (e.code !== 'ERR_SQLITE_ERROR') throw e;
      skipped += 1;
    } finally { db?.close(); }
  }
  return { events, sessions, skipped };
}
