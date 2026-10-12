// Claude Code sessions: <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<dir>/<session id>.jsonl, one JSON record per
// line, and the session's subagent files <session id>/subagents/**/agent-*.jsonl. The dir name loses data, so a
// session belongs to the cwd of its first record; a subagent file belongs to its parent session.
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

export const root = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

// A command that runs tests, at its start or after ;, &&, || or a pipe (env assignments before it are fine).
export const TEST = /(?:^|[;&|(]\s*)(?:\w+=\S*\s+)*(?:(?:npm|pnpm|yarn|bun|deno|go|cargo|make|mix|dotnet)\s+(?:run\s+)?test\b|(?:npx\s+)?(?:jest|vitest|pytest|mocha|rspec|phpunit)\b|node\s+--test\b|python3?\s+-m\s+(?:pytest|unittest)\b)/;
const WRAPPER = /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|user-prompt-submit-hook)>/;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text ?? '').join('\n') : '');
const inputText = (input) => Object.values(input ?? {}).filter((v) => typeof v === 'string').join(' ');
const list = (dir, opts, miss) => { try { return readdirSync(dir, opts); } catch (e) { miss(e); return []; } };
const fresh = (file, from, miss) => { try { return statSync(file).mtimeMs >= from; } catch (e) { miss(e); return false; } };

// One file's events, streamed line by line (a session file can be larger than one string can hold).
// Returns null when `keep` refuses the first cwd, or the first user message carries the lfm-run: marker.
async function parse(file, { session, keep, sub, excerpt }) {
  const events = [], calls = new Map(), failed = new Set();
  let skipped = 0, n = 0, cwd, start = null, first = true, afterError = false;
  const input = createReadStream(file), lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      n += 1;
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { skipped += 1; continue; }
      if (!r || typeof r !== 'object' || typeof r.type !== 'string') { skipped += 1; continue; }
      if (!sub && cwd === undefined && typeof r.cwd === 'string' && !keep((cwd = r.cwd))) return null;
      const at = { agent: 'claude', session_id: session, ts: typeof r.timestamp === 'string' ? r.timestamp : null, ref: `${file}:${n}` };
      start ??= at.ts;
      const blocks = typeof r.message?.content === 'string' ? [{ type: 'text', text: r.message.content }] : Array.isArray(r.message?.content) ? r.message.content : [];
      if (r.type === 'assistant') {
        if (blocks.some((b) => b?.type === 'text')) afterError = false; // an assistant reply ends the adjacency
        for (const b of blocks) {
          if (b?.type !== 'tool_use') continue;
          const key = `${b.name}\0${JSON.stringify(b.input)}`;
          calls.set(b.id, { tool: b.name, key, command: typeof b.input?.command === 'string' ? b.input.command : '' });
          const retry = failed.has(key); // the same call again after it failed
          events.push({ ...at, kind: 'tool_call', tool: b.name, signal: retry ? 'retry' : null, excerpt: retry ? excerpt(inputText(b.input)) : '' });
        }
      }
      if (r.type !== 'user' || r.isMeta) continue;
      const results = blocks.filter((b) => b?.type === 'tool_result');
      for (const b of results) {
        const call = calls.get(b.tool_use_id), text = textOf(b.content);
        const interrupted = r.toolUseResult?.interrupted === true;
        const benign = Boolean(r.toolUseResult?.returnCodeInterpretation);
        const error = (b.is_error === true && !benign) || interrupted;
        const exit = /^(?:Error: )?Exit code (\d+)/.exec(text)?.[1];
        // A tool use the user turned down is not a tool failure; the interrupt or correction after it is counted.
        const declined = ['user-rejected', 'interrupted'].includes(r.toolDenialKind);
        const signal = !error || declined ? null : interrupted ? 'interrupt' : TEST.test(call?.command ?? '') ? 'test_fail' : exit ? 'nonzero_exit' : 'tool_error';
        events.push({ ...at, kind: 'tool_result', tool: call?.tool ?? null, status: error ? 'error' : 'ok', exit_code: exit ? Number(exit) : null, signal, excerpt: signal ? excerpt(text) : '' });
        if (error && call && !declined) failed.add(call.key);
        else if (!error && call) failed.delete(call.key); // a later repeat is no longer a retry
        afterError ||= error;
      }
      // A subagent's user messages come from its parent agent, never from a person.
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
      if (sub || results.length || r.isCompactSummary || !(text.trim() || blocks.some((b) => b?.type === 'image'))) continue;
      if (first && text.trimStart().startsWith('lfm-run:')) return null; // this tool's own agent session
      first = false;
      if (WRAPPER.test(text)) { afterError = false; continue; } // a command, hook or system message Claude Code wraps in a tag
      if (text.startsWith('[Request interrupted')) events.push({ ...at, kind: 'interrupt', signal: 'interrupt', excerpt: '' });
      // A person's message right after a tool error, with no assistant reply between, corrects the agent.
      else events.push({ ...at, kind: afterError ? 'correction' : 'user_msg', signal: afterError ? 'correction' : null, excerpt: afterError ? excerpt(text) : '' });
      afterError = false;
    }
  } catch (e) {
    if (e.code === 'ENOENT') return null; // the agent removed it after the listing
    throw e;
  } finally { lines.close(); input.destroy(); }
  if (!sub && cwd === undefined) return null; // no record says where it ran
  return { events, skipped, start };
}

// Every session in the store whose file changed since `readFrom` and whose cwd `keep` accepts.
// `skip` holds session ids this tool started itself.
export async function read({ readFrom, keep, excerpt, skip }) {
  const events = [];
  let sessions = 0, skipped = 0;
  // A path that cannot be listed or stat'd is counted, except one that is gone; the other sessions still read.
  const miss = (e) => { if (e.code !== 'ENOENT') skipped += 1; };
  // A file that cannot be read is skipped and counted; the other sessions still read.
  const file = async (p, opts) => {
    try { return await parse(p, opts); } catch (e) { if (!e.syscall) throw e; skipped += 1; return null; }
  };
  for (const d of list(root(), { withFileTypes: true }, miss)) {
    if (!d.isDirectory()) continue;
    const dir = join(root(), d.name);
    for (const f of list(dir, undefined, miss)) {
      const session = f.slice(0, -'.jsonl'.length);
      if (!f.endsWith('.jsonl') || skip.has(session)) continue;
      // A subagent can still write after its parent file last changed: either one being fresh reads the session.
      const subs = list(join(dir, session, 'subagents'), { recursive: true }, miss).filter((p) => /^agent-.*\.jsonl$/.test(basename(p)))
        .map((p) => join(dir, session, 'subagents', p)).filter((p) => fresh(p, readFrom, miss));
      if (!fresh(join(dir, f), readFrom, miss) && !subs.length) continue;
      const main = await file(join(dir, f), { session, keep, excerpt });
      if (!main) continue;
      sessions += 1;
      events.push({ agent: 'claude', session_id: session, ts: main.start, ref: `${join(dir, f)}:1`, kind: 'session_start', excerpt: '' }, ...main.events);
      skipped += main.skipped;
      for (const p of subs) {
        const got = await file(p, { session, sub: true, excerpt });
        events.push(...(got?.events ?? []));
        skipped += got?.skipped ?? 0;
      }
    }
  }
  return { events, sessions, skipped };
}
