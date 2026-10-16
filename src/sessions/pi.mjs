// Pi sessions: <PI_CODING_AGENT_SESSION_DIR or <PI_CODING_AGENT_DIR or ~/.pi/agent>/sessions>/--<path>--/*.jsonl. The
// header line has the session id and cwd; a message is a user, assistant (toolCall blocks; stopReason aborted when the
// user stops it) or toolResult (isError) one. From Pi's own session-format and message-types docs and its bash tool.
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { failSignal, fresh, inputText, json, list, textOf } from './claude.mjs';

export const STORE_VAR = 'PI_CODING_AGENT_SESSION_DIR';
export const root = () => process.env[STORE_VAR] || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'sessions');

// One file's events, streamed line by line. Returns null when `keep` refuses the header cwd, the file has no header,
// or the first user message carries the lfm-run: marker.
async function parse(file, { keep, excerpt }) {
  const events = [], calls = new Map(), failed = new Set();
  let skipped = 0, n = 0, cwd, id = basename(file, '.jsonl'), start = null, fork = false, first = true, afterError = false;
  const input = createReadStream(file), lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      n += 1;
      if (!line.trim()) continue;
      const r = json(line);
      if (!r || typeof r !== 'object' || typeof r.type !== 'string') { skipped += 1; continue; }
      if (n === 1 && r.type === 'session') {
        if (typeof r.cwd !== 'string' || !keep((cwd = r.cwd))) return null;
        if (typeof r.id === 'string' && r.id) id = r.id;
        start = typeof r.timestamp === 'string' ? r.timestamp : null, fork = typeof r.parentSession === 'string';
        continue;
      }
      // Model changes, usage and compaction are not turns; a fork's copy of its parent's entries keeps their older times.
      if (r.type !== 'message' || (fork && typeof r.timestamp === 'string' && r.timestamp < start)) continue;
      const m = r.message;
      if (!m || typeof m !== 'object' || typeof m.role !== 'string') { skipped += 1; continue; }
      const at = { agent: 'pi', session_id: id, ts: typeof r.timestamp === 'string' ? r.timestamp : null, ref: `${file}:${n}` };
      if (m.role === 'assistant') {
        const blocks = Array.isArray(m.content) ? m.content : [];
        if (blocks.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim())) afterError = false; // a reply ends the adjacency
        for (const b of blocks) {
          if (b?.type !== 'toolCall') continue;
          const key = `${b.name}\0${JSON.stringify(b.arguments)}`;
          calls.set(b.id, { tool: b.name, key, command: typeof b.arguments?.command === 'string' ? b.arguments.command : '' });
          const retry = failed.has(key); // the same call again after it failed
          events.push({ ...at, kind: 'tool_call', tool: b.name ?? null, signal: retry ? 'retry' : null, excerpt: retry ? excerpt(inputText(b.arguments)) : '' });
        }
        if (m.stopReason === 'aborted') { events.push({ ...at, kind: 'interrupt', signal: 'interrupt', excerpt: '' }); afterError = false; }
      } else if (m.role === 'toolResult') {
        const call = calls.get(m.toolCallId), text = textOf(m.content), error = m.isError === true;
        const exit = /Command exited with code (\d+)\s*$/.exec(text)?.[1]; // the bash tool's own last line
        // A call the user stopped is not a tool failure; the interrupt after it is counted. Pi itself writes these texts.
        const declined = error && /(?:Command|Operation) aborted\s*$/.test(text);
        const { signal, fromOutput } = failSignal(call?.command ?? '', text, { error, declined, exit });
        events.push({ ...at, kind: 'tool_result', tool: call?.tool ?? m.toolName ?? null, status: error ? 'error' : 'ok', exit_code: exit ? Number(exit) : null, signal, from_output: fromOutput, excerpt: signal ? excerpt(text) : '' });
        if (call) { if (error && !declined) failed.add(call.key); else failed.delete(call.key); } // a later repeat after a success is no retry
        afterError ||= error;
      } else if (m.role === 'user') {
        const text = textOf(m.content);
        if (!text.trim() && !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'image'))) continue;
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
  return cwd === undefined ? null : { events, skipped, start, id };
}

// Every session in the store whose file changed since `readFrom` and whose header cwd `keep` accepts.
// `skip` holds session ids this tool started itself.
export async function read({ readFrom, keep, excerpt, skip }) {
  const events = [];
  let sessions = 0, skipped = 0;
  // A path that cannot be listed, stat'd or read is counted, except one that is gone; the other sessions still read.
  const miss = (e) => { if (e.code !== 'ENOENT') skipped += 1; };
  for (const d of list(root(), { withFileTypes: true }, miss)) {
    if (!d.isDirectory()) continue;
    for (const f of list(join(root(), d.name), undefined, miss)) {
      const p = join(root(), d.name, f);
      if (!f.endsWith('.jsonl') || !fresh(p, readFrom, miss)) continue;
      let got;
      try { got = await parse(p, { keep, excerpt }); } catch (e) { if (!e.syscall) throw e; skipped += 1; continue; }
      if (!got || skip.has(got.id)) continue;
      sessions += 1;
      events.push({ agent: 'pi', session_id: got.id, ts: got.start, ref: `${p}:1`, kind: 'session_start', excerpt: '' }, ...got.events);
      skipped += got.skipped;
    }
  }
  return { events, sessions, skipped };
}
