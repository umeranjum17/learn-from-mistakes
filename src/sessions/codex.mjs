// Codex sessions: <CODEX_HOME or ~/.codex>/state_5.sqlite lists every thread with its cwd and rollout file, one JSON
// record per line. The thread list is opened read-only. A subagent thread belongs to the session that spawned it.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { inputText, json, TEST, textOf } from './claude.mjs';

export const root = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'state_5.sqlite');

// Messages Codex itself adds as user input: AGENTS.md text and tags such as <environment_context> or
// <codex_internal_context source="goal">. An <image name=...> label starts a person's message with an image.
const WRAPPER = /^\s*(?:<(?!image\b)[\w-]+[\s>]|# AGENTS\.md instructions)/;
// The exit code a shell call reports in its own header, the lines before the first Output: line; else the JSON
// metadata a legacy shell returns; a code-mode script's first nonzero nested "exit_code". ponytail: a script that prints
// "exit_code" as data reads as one (about 1 in 2000 here).
const HEADER_EXIT = /^(?:Chunk ID: .*\n)?(?:Wall time: .*\n)?(?:Process exited with code |Exit code: )(\d+)/;
const exitOf = (text, tool) => {
  if (tool === 'exec') {
    const codes = [...text.matchAll(/"exit_code":\s*(\d+)/g)].map((x) => Number(x[1]));
    return codes.find(Boolean) ?? codes[0] ?? null;
  }
  if (!['exec_command', 'shell', 'local_shell_call'].includes(tool)) return null;
  const end = text.search(/^Output:/m), m = end < 0 ? null : HEADER_EXIT.exec(text.slice(0, end));
  if (m) return Number(m[1]);
  if (tool === 'exec_command') return null;
  const code = json(text)?.metadata?.exit_code;
  return Number.isInteger(code) ? code : null;
};

// The script a shell runs, so TEST reads `npm test` in `bash -lc 'npm test' | tail -5` (an argv joined by spaces, or a string).
const unwrap = (c) => c.replace(/^(?:\S*\/)?(?:ba|z|da)?sh -l?c ["']?/, '');

// One rollout's events, streamed line by line. Returns null when the first user message carries the lfm-run: marker.
async function parse(file, { session, sub, excerpt }) {
  const events = [], calls = new Map(), failed = new Set(), badPatch = new Set();
  let skipped = 0, n = 0, start = null, first = true, afterError = false;
  const input = createReadStream(file), lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      n += 1;
      if (!line.trim()) continue;
      const r = json(line), p = r?.payload;
      if (!r || typeof r !== 'object' || typeof r.type !== 'string') { skipped += 1; continue; }
      const at = { agent: 'codex', session_id: session, ts: typeof r.timestamp === 'string' ? r.timestamp : null, ref: `${file}:${n}` };
      start ??= at.ts;
      if (r.type === 'event_msg' && p?.type === 'patch_apply_end' && p.success === false) badPatch.add(p.call_id);
      if (r.type === 'event_msg' && p?.type === 'turn_aborted' && p.reason === 'interrupted') {
        events.push({ ...at, kind: 'interrupt', signal: 'interrupt', excerpt: '' });
        afterError = false;
      }
      if (r.type !== 'response_item' || !p) continue;
      if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) {
        const raw = p.arguments ?? p.input ?? JSON.stringify(p.action ?? null), args = json(raw);
        const command = typeof args?.cmd === 'string' ? unwrap(args.cmd) : Array.isArray(args?.command) ? unwrap(args.command.join(' ')) : '';
        const key = `${p.name}\0${raw}`;
        calls.set(p.call_id, { tool: p.name ?? p.type, key, command });
        const retry = failed.has(key); // the same call again after it failed
        events.push({ ...at, kind: 'tool_call', tool: p.name ?? p.type, signal: retry ? 'retry' : null, excerpt: retry ? excerpt(args && typeof args === 'object' && !Array.isArray(args.command) ? inputText(args) : command || String(raw)) : '' });
      } else if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(p.type)) {
        const call = calls.get(p.call_id), text = textOf(p.output);
        const exit = exitOf(text, call?.tool);
        const error = Boolean(exit) || badPatch.has(p.call_id);
        const signal = !error ? null : TEST.test(call?.command ?? '') ? 'test_fail' : exit ? 'nonzero_exit' : 'tool_error';
        events.push({ ...at, kind: 'tool_result', tool: call?.tool ?? null, status: error ? 'error' : 'ok', exit_code: exit, signal, excerpt: signal ? excerpt(text) : '' });
        if (error && call) failed.add(call.key);
        else if (call) failed.delete(call.key); // a later repeat is no longer a retry
        afterError ||= error;
      } else if (p.type === 'message' && p.role === 'assistant') {
        if (textOf(p.content).trim()) afterError = false; // an assistant reply ends the adjacency
      } else if (p.type === 'message' && p.role === 'user' && !sub) { // a subagent's user messages come from its parent agent
        const blocks = Array.isArray(p.content) ? p.content : [];
        const text = blocks.filter((b) => b?.type === 'input_text').map((b) => b.text).join('\n');
        if (!(text.trim() || blocks.some((b) => b?.type === 'input_image'))) continue;
        if (WRAPPER.test(text)) continue;
        if (first && text.trimStart().startsWith('lfm-run:')) return null; // this tool's own agent session
        first = false;
        // A person's message right after a tool error, with no assistant reply between, corrects the agent.
        events.push({ ...at, kind: afterError ? 'correction' : 'user_msg', signal: afterError ? 'correction' : null, excerpt: afterError ? excerpt(text) : '' });
        afterError = false;
      }
    }
  } catch (e) {
    if (e.code === 'ENOENT') return null; // the agent removed it after the listing
    throw e;
  } finally { lines.close(); input.destroy(); }
  return { events, skipped, start };
}

// Every session whose thread cwd `keep` accepts and whose rollout, or a subagent's, changed since `readFrom`.
// `skip` holds session ids this tool started itself.
export async function read({ readFrom, keep, excerpt, skip }) {
  const events = [];
  let sessions = 0, skipped = 0, threads;
  if (!existsSync(root())) return { events, sessions, skipped }; // no Codex here
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(root(), { readOnly: true });
  try { threads = db.prepare('SELECT id, rollout_path AS file, cwd, source FROM threads ORDER BY created_at, id').all(); } finally { db.close(); }
  const byId = new Map(threads.map((t) => [t.id, t]));
  const top = (t) => { // the session a thread belongs to: the top of its spawn chain
    for (let i = 0; i < 64; i++) {
      const parent = byId.get(json(t.source)?.subagent?.thread_spawn?.parent_thread_id);
      if (!parent) return t;
      t = parent;
    }
    return t;
  };
  const groups = new Map();
  for (const t of threads) {
    const s = top(t);
    if (!groups.has(s.id)) groups.set(s.id, []);
    groups.get(s.id).push(t);
  }
  const file = async (t, opts) => {
    try { return await parse(t.file, opts); } catch (e) { if (!e.syscall) throw e; skipped += 1; return null; }
  };
  for (const [session, members] of groups) {
    const main = byId.get(session), subs = members.filter((t) => t !== main);
    if (skip.has(session) || typeof main.cwd !== 'string' || !keep(main.cwd)) continue;
    const fresh = members.filter((t) => { try { return statSync(t.file).mtimeMs >= readFrom; } catch (e) { if (e.code !== 'ENOENT') skipped += 1; return false; } });
    if (!fresh.length) continue;
    const got = await file(main, { session, excerpt });
    if (!got) continue;
    sessions += 1;
    events.push({ agent: 'codex', session_id: session, ts: got.start, ref: `${main.file}:1`, kind: 'session_start', excerpt: '' }, ...got.events);
    skipped += got.skipped;
    for (const t of subs.filter((x) => fresh.includes(x))) {
      const s = await file(t, { session, sub: true, excerpt });
      events.push(...(s?.events ?? []));
      skipped += s?.skipped ?? 0;
    }
  }
  return { events, sessions, skipped };
}
