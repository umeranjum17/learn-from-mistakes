// Claude Code sessions: <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<dir>/<session id>.jsonl, one JSON record per
// line, and the session's subagent files <session id>/subagents/**/agent-*.jsonl. The dir name loses data, so a
// session belongs to the cwd of its first record; a subagent file belongs to its parent session.
// With `tokens`, a read also keeps what the tokens retro counts: one request event per message id (Claude writes one
// record per content block, so each usage field is the largest any of them carries), each tool call's id, request,
// command and file, each result's size, the compaction boundaries, and the subagent file an event came from.
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

export const STORE_VAR = 'CLAUDE_CONFIG_DIR';
export const root = () => join(process.env[STORE_VAR] || join(homedir(), '.claude'), 'projects');

// A command that runs tests, at its start or after ;, &&, || or a pipe (env assignments before it are fine).
export const TEST = /(?:^|[;&|(]\s*)(?:\w+=\S*\s+)*(?:(?:npm|pnpm|yarn|bun|deno|go|cargo|make|mix|dotnet)\s+(?:run\s+)?test\b|(?:npx\s+)?(?:jest|vitest|pytest|mocha|rspec|phpunit)\b|node\s+--test\b|python3?\s+-m\s+(?:pytest|unittest)\b)/;
// A pipe's exit code is its last command's, so `npm test | tail -5` exits 0 with red tests and no error flag. When
// neither the error flag nor the exit code shows the failure, the output's own summary line of a common runner does,
// each anchored to its line shape, with N above zero: node --test (`ℹ fail N` / `# fail N`), jest (`Tests: N failed`),
// vitest (`Tests  N failed`) and pytest (`N failed` in its ===== summary line). Other runner text (a stray "3 failed
// to download"), and output cut before the summary line (for example `npm test | head`), stay invisible.
const RUNNER_FAILS = [
  /^\s*[ℹ#] fail [1-9]\d*\s*$/m, // node --test: the spec reporter prints ℹ, the TAP reporter #
  /^Tests:.*\b[1-9]\d* failed\b/m, // jest
  /^\s*Tests\s+[1-9]\d* failed/m, // vitest
  /^=+.*\b[1-9]\d* failed\b.*=+\s*$/m, // pytest
];

// A tool result's failure signal from its command, output text and flags; `exit` is the parsed exit code (a number or
// numeric string) or null. A stopped (declined) or interrupted call is no tool failure; a TEST command fails on its
// error flag or a nonzero exit, else on its output's own runner summary line, and only such an event reads as from the
// output (fromOutput). Any other failure is a nonzero exit or a tool error.
export function failSignal(command, text, { error, declined, exit, interrupted }) {
  if (interrupted) return { signal: 'interrupt', fromOutput: false };
  if (error && !declined) return { signal: TEST.test(command) ? 'test_fail' : exit ? 'nonzero_exit' : 'tool_error', fromOutput: false };
  return TEST.test(command) && !(exit > 0) && RUNNER_FAILS.some((r) => r.test(text))
    ? { signal: 'test_fail', fromOutput: true } : { signal: null, fromOutput: false };
}
const WRAPPER = /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|user-prompt-submit-hook)>/;
export const json = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
export const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text ?? '').join('\n') : '');
export const inputText = (input) => Object.values(input ?? {}).filter((v) => typeof v === 'string').join(' ');
export const list = (dir, opts, miss) => { try { return readdirSync(dir, opts); } catch (e) { miss(e); return []; } };
export const fresh = (file, from, miss) => { try { return statSync(file).mtimeMs >= from; } catch (e) { miss(e); return false; } };

// One file's events, streamed line by line (a session file can be larger than one string can hold).
// Returns null when `keep` refuses the first cwd, or the first user message carries the lfm-run: marker.
async function parse(file, { session, keep, sub, excerpt, tokens, head }) {
  const events = [], calls = new Map(), failed = new Set(), requests = new Map();
  let skipped = 0, n = 0, cwd, start = null, first = true, afterError = false;
  const input = createReadStream(file), lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      n += 1;
      if (head && n > head) break; // a probe reads only the first lines
      if (!line.trim()) continue;
      if (line.startsWith('{"type":"api-request') || line.startsWith('{"type":"file-history')) continue; // a copy of the request or a file backup, never a turn
      let r;
      try { r = JSON.parse(line); } catch { skipped += 1; continue; }
      if (!r || typeof r !== 'object' || typeof r.type !== 'string') { skipped += 1; continue; }
      if (!sub && cwd === undefined && typeof r.cwd === 'string' && !keep((cwd = r.cwd))) return null;
      const at = { agent: 'claude', session_id: session, ts: typeof r.timestamp === 'string' ? r.timestamp : null, ref: `${file}:${n}`, ...(tokens && sub && { sub: basename(file, '.jsonl') }) };
      start ??= at.ts;
      if (tokens && r.type === 'system' && r.subtype === 'compact_boundary') events.push({ ...at, kind: 'compaction' });
      const blocks = typeof r.message?.content === 'string' ? [{ type: 'text', text: r.message.content }] : Array.isArray(r.message?.content) ? r.message.content : [];
      if (r.type === 'assistant') {
        if (blocks.some((b) => b?.type === 'text')) afterError = false; // an assistant reply ends the adjacency
        const id = r.message?.id, u = r.message?.usage;
        if (tokens && typeof id === 'string' && u && typeof u === 'object') {
          const got = { input: u.input_tokens, cache_write: u.cache_creation_input_tokens, cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens, cache_read: u.cache_read_input_tokens, output: u.output_tokens };
          let req = requests.get(id);
          if (!req) { requests.set(id, (req = { ...at, kind: 'request', id, model: r.message.model ?? null, tools: 0, input: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0, output: 0 })); events.push(req); }
          for (const [k, v] of Object.entries(got)) if (Number.isFinite(v)) req[k] = Math.max(req[k], v);
          req.tools += blocks.filter((b) => b?.type === 'tool_use').length;
        }
        for (const b of blocks) {
          if (b?.type !== 'tool_use') continue;
          const key = `${b.name}\0${JSON.stringify(b.input)}`, command = typeof b.input?.command === 'string' ? b.input.command : '';
          calls.set(b.id, { tool: b.name, key, command });
          const retry = failed.has(key); // the same call again after it failed
          events.push({ ...at, kind: 'tool_call', tool: b.name, signal: retry ? 'retry' : null, excerpt: retry ? excerpt(inputText(b.input)) : '',
            ...(tokens && { id: b.id, req: id, command, file: b.input?.file_path ?? b.input?.notebook_path ?? null, full: b.input?.offset === undefined && b.input?.limit === undefined }) });
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
        const { signal, fromOutput } = failSignal(call?.command ?? '', text, { error, declined, exit, interrupted });
        events.push({ ...at, kind: 'tool_result', tool: call?.tool ?? null, status: error ? 'error' : 'ok', exit_code: exit ? Number(exit) : null, signal, from_output: fromOutput, excerpt: signal ? excerpt(text) : '',
          ...(tokens && { call: b.tool_use_id, chars: text.length }) });
        if (error && call && !declined) failed.add(call.key);
        else if (!error && call) failed.delete(call.key); // a later repeat is no longer a retry
        afterError ||= error;
      }
      // A subagent's user messages come from its parent agent, never from a person.
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
      if (sub || results.length || r.isCompactSummary || !(text.trim() || blocks.some((b) => b?.type === 'image'))) continue;
      if (first && text.trimStart().startsWith('lfm-run:')) return null; // this tool's own agent session
      first = false;
      if (WRAPPER.test(text)) continue; // a command, hook or system message Claude Code wraps in a tag
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
  // A record of all-zero usage (a synthetic or a cancelled message) made no request.
  return { events: tokens ? events.filter((e) => e.kind !== 'request' || e.input + e.cache_write + e.cache_read + e.output > 0) : events, skipped, start };
}

// Every session in the store whose file changed since `readFrom` and whose cwd `keep` accepts.
// `skip` holds session ids this tool started itself. With `each`, each session's events go to it and none are kept;
// `problem` hears each path that could not be listed, stat'd or read; `head` reads only each file's first lines.
export async function read({ readFrom, keep, excerpt, skip, tokens = false, each, problem, head }) {
  const events = [];
  let sessions = 0, skipped = 0;
  // A path that cannot be listed or stat'd is counted, except one that is gone; the other sessions still read.
  const miss = (e) => { if (e.code !== 'ENOENT') { skipped += 1; problem?.(e); } };
  // A file that cannot be read is skipped and counted; the other sessions still read.
  const file = async (p, opts) => {
    try { return await parse(p, { ...opts, tokens, head }); } catch (e) { if (!e.syscall) throw e; skipped += 1; problem?.(e); return null; }
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
      const own = [{ agent: 'claude', session_id: session, ts: main.start, ref: `${join(dir, f)}:1`, kind: 'session_start', excerpt: '' }, ...main.events];
      skipped += main.skipped;
      for (const p of subs) {
        const got = await file(p, { session, sub: true, excerpt });
        own.push(...(got?.events ?? []));
        skipped += got?.skipped ?? 0;
      }
      if (each) each(own); else for (const e of own) events.push(e);
    }
  }
  return { events, sessions, skipped };
}
