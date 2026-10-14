// Gemini CLI sessions: <GEMINI_CLI_HOME or ~>/.gemini/tmp/<slug>/chats/session-*.jsonl, with .gemini/projects.json
// mapping each project path to its slug ({projects: {<path>: <slug>}}), and a subagent's chats/<parent id>/*.jsonl.
// A chat line is the metadata ({sessionId, startTime}), a message ({id, type: user|gemini, content, toolCalls: [{name,
// args, result, status: success|error|cancelled}]}), a {$set} or a {$rewindTo}. From the CLI's own bundled code.
import { createReadStream, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fresh, inputText, json, list, TEST, textOf } from './claude.mjs';

export const STORE_VAR = 'GEMINI_CLI_HOME';
export const root = () => join(process.env[STORE_VAR] || homedir(), '.gemini');

// What the CLI itself does not count as a person's message: a command, a question or injected context.
const WRAPPER = /^\s*(?:\/[a-z][\w:-]*(?:\s|$)|\?|<session_context>|<hook_context>|Here is the user's editor context)/;
// A function response's output or error text; a shell command that exits nonzero still has status success.
const resultText = (r) => (Array.isArray(r) ? r.map((p) => p?.text ?? p?.functionResponse?.response?.output ?? p?.functionResponse?.response?.error ?? '').join('\n') : '');

// One file's events. A message rewritten under the same id keeps its place and takes the later record, as the CLI's
// own loader does; $set.messages replaces them all and $rewindTo drops that id onwards (all of them when it is gone).
// Returns null when the file names no session, or the first user message carries the lfm-run: marker.
async function parse(file, { session, excerpt }) {
  const events = [], failed = new Set(), msgs = new Map();
  let skipped = 0, n = 0, meta = {}, first = true, afterError = false;
  const input = createReadStream(file), lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      n += 1;
      if (!line.trim()) continue;
      const r = json(line);
      if (!r || typeof r !== 'object') skipped += 1;
      else if (typeof r.$rewindTo === 'string') {
        const ids = [...msgs.keys()], at = ids.indexOf(r.$rewindTo);
        for (const id of ids.slice(Math.max(at, 0))) msgs.delete(id);
      } else if (r.$set && typeof r.$set === 'object') {
        meta = { ...meta, ...r.$set };
        if (Array.isArray(r.$set.messages)) { msgs.clear(); for (const m of r.$set.messages) if (typeof m?.id === 'string') msgs.set(m.id, { m, n }); }
      } else if (typeof r.sessionId === 'string') meta = { ...meta, ...r };
      else if (typeof r.id === 'string' && typeof r.type === 'string') msgs.set(r.id, { m: r, n });
      else skipped += 1;
    }
  } catch (e) {
    if (e.code === 'ENOENT') return null; // the agent removed it after the listing
    throw e;
  } finally { lines.close(); input.destroy(); }
  const id = typeof meta.sessionId === 'string' ? meta.sessionId : null;
  if (!id) return null;
  for (const { m, n: line } of msgs.values()) {
    const at = { agent: 'gemini', session_id: session ?? id, ts: typeof m.timestamp === 'string' ? m.timestamp : null, ref: `${file}:${line}` };
    if (m.type === 'gemini') {
      if (textOf(m.content).trim()) afterError = false; // a reply ends the adjacency
      for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        const key = `${tc?.name}\0${JSON.stringify(tc?.args)}`, command = typeof tc?.args?.command === 'string' ? tc.args.command : '';
        const retry = failed.has(key); // the same call again after it failed
        events.push({ ...at, kind: 'tool_call', tool: tc?.name ?? null, signal: retry ? 'retry' : null, excerpt: retry ? excerpt(inputText(tc?.args)) : '' });
        // A call the user stopped is not a tool failure; the interrupt is counted.
        if (tc?.status === 'cancelled') { events.push({ ...at, kind: 'interrupt', signal: 'interrupt', excerpt: '' }); afterError = false; continue; }
        const text = resultText(tc?.result), exit = command ? Number(/(?:^|\n)Exit Code: (\d+)\s*$/.exec(text)?.[1] ?? 0) || null : null;
        const error = tc?.status === 'error' || Boolean(exit);
        const signal = !error ? null : TEST.test(command) ? 'test_fail' : exit ? 'nonzero_exit' : 'tool_error';
        events.push({ ...at, kind: 'tool_result', tool: tc?.name ?? null, status: error ? 'error' : 'ok', exit_code: exit, signal, excerpt: signal ? excerpt(text) : '' });
        if (error) failed.add(key); else failed.delete(key); // a later repeat after a success is no retry
        afterError ||= error;
      }
    } else if (m.type === 'user' && !session) { // a subagent's user messages come from its parent agent
      const text = textOf(m.content);
      if (!(text.trim() || (Array.isArray(m.content) && m.content.some((p) => p?.inlineData))) || WRAPPER.test(text)) { afterError = false; continue; }
      if (first && text.trimStart().startsWith('lfm-run:')) return null; // this tool's own agent session
      first = false;
      // A person's message right after a tool error, with no assistant reply between, corrects the agent.
      events.push({ ...at, kind: afterError ? 'correction' : 'user_msg', signal: afterError ? 'correction' : null, excerpt: afterError ? excerpt(text) : '' });
      afterError = false;
    }
  }
  return { events, skipped, id, start: typeof meta.startTime === 'string' ? meta.startTime : null };
}

// Every session whose project path `keep` accepts and whose chat file, or one of its subagent files, changed since
// `readFrom`. `skip` holds session ids this tool started itself.
export async function read({ readFrom, keep, excerpt, skip }) {
  const events = [];
  let sessions = 0, skipped = 0, projects;
  try { projects = JSON.parse(readFileSync(join(root(), 'projects.json'), 'utf8'))?.projects ?? {}; } catch (e) {
    if (e.code !== 'ENOENT') throw Object.assign(e, { path: e.path ?? join(root(), 'projects.json') });
    return { events, sessions, skipped };
  }
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const slugs = new Set(Object.entries(projects).filter(([p, s]) => typeof s === 'string' && keep(real(p))).map(([, s]) => s));
  // A path that cannot be listed, stat'd or read is counted, except one that is gone; the other sessions still read.
  const miss = (e) => { if (e.code !== 'ENOENT') skipped += 1; };
  const file = async (p, opts) => { try { return await parse(p, opts); } catch (e) { if (!e.syscall) throw e; skipped += 1; return null; } };
  for (const slug of slugs) {
    const chats = join(root(), 'tmp', slug, 'chats'), names = list(chats, undefined, miss);
    for (const f of names.filter((x) => /^session-.{16}-.+\.jsonl$/.test(x))) {
      // A subagent dir is named for its parent session's id, whose first 8 characters end the file name.
      const prefix = f.slice('session-'.length + 17, -'.jsonl'.length);
      const subs = names.filter((d) => d.startsWith(prefix) && !d.endsWith('.jsonl'))
        .flatMap((d) => list(join(chats, d), undefined, miss).filter((x) => x.endsWith('.jsonl')).map((x) => ({ d, p: join(chats, d, x) })))
        .filter((s) => fresh(s.p, readFrom, miss));
      if (!fresh(join(chats, f), readFrom, miss) && !subs.length) continue;
      const got = await file(join(chats, f), { excerpt });
      if (!got || skip.has(got.id)) continue;
      sessions += 1;
      events.push({ agent: 'gemini', session_id: got.id, ts: got.start, ref: `${join(chats, f)}:1`, kind: 'session_start', excerpt: '' }, ...got.events);
      skipped += got.skipped;
      for (const s of subs.filter((x) => x.d === got.id)) {
        const sub = await file(s.p, { session: got.id, excerpt });
        events.push(...(sub?.events ?? []));
        skipped += sub?.skipped ?? 0;
      }
    }
  }
  return { events, sessions, skipped };
}
