// Optional account picker: a command-line program that speaks JSON protocol v1 (stdin request, stdout answer).
// The config key and ACCOUNT_PICKER env hold an argv (command and arguments, never shell text). Unset: no picker.
// Answers carry a selection id, folder paths and variable names to set or unset. Never credentials.
import { execFile } from 'node:child_process';
import { InputError } from '../../bin/learn-from-mistakes-axi.mjs';

const PICKER_MS = 15_000;
const PICKER_BYTES = 65_536;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN = new Set(['HOME', 'PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH']);
const HARNESS = { claude: 'claude', codex: 'codex', opencode: 'opencode', pi: 'pi', gemini: 'gemini' };
const on = (v) => v === true || v === 1 || v === 'true' || v === '1' || v === 'yes';

export function parsePicker(value, where) {
  if (value == null || value === '') return undefined;
  let argv = value;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.startsWith('[')) {
      try { argv = JSON.parse(t); } catch { throw new InputError(`${where} must be a JSON argv array`); }
    } else if (/\s/.test(t)) throw new InputError(`${where} must be an argv (a list of strings), not shell text`);
    else argv = [t];
  }
  if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string' && a)) {
    throw new InputError(`${where} must be a non-empty argv (command and arguments, never shell text)`);
  }
  return argv;
}

export function pickerArgv(cfg) {
  const env = process.env.ACCOUNT_PICKER ?? process.env.account_picker;
  if (env !== undefined && env !== '') return parsePicker(env, 'ACCOUNT_PICKER');
  return cfg.account_picker;
}

export function creditsOn(sel) {
  if (!sel || typeof sel !== 'object') return false;
  if (sel.billing === 'credits' || sel.billing === 'overage' || sel.billing_classification === 'credits' || sel.billing_classification === 'overage') return true;
  if (on(sel.usage_credits) || on(sel.extra_usage) || on(sel.overage)) return true;
  const b = sel.billing;
  return Boolean(b && typeof b === 'object' && (on(b.usage_credits) || on(b.extra_usage) || on(b.overage) || on(b.credits)));
}

export function selectionId(sel) {
  const id = sel?.selection_id || sel?.id;
  return typeof id === 'string' && id ? id : '';
}

export function mapSelection(sel, fallback) {
  const id = selectionId(sel);
  const harness = sel.harness || sel.provider;
  if (harness && !HARNESS[harness]) return { refuse: id || String(harness) };
  const runner = HARNESS[harness] || fallback.runner;
  if (!runner || !(runner in HARNESS) && runner !== fallback.runner) return { refuse: id || String(harness || 'unknown') };
  return { runner, model: sel.model || fallback.model, id };
}

export function childEnv(set, unset) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(set ?? {})) {
    if (!NAME.test(k) || FORBIDDEN.has(k)) throw new InputError(`account picker: refused env name ${k}`);
    if (typeof v !== 'string') throw new InputError(`account picker: set.${k} must be a string (a path or value, never credentials)`);
    env[k] = v;
  }
  for (const k of unset ?? []) {
    if (typeof k !== 'string' || !NAME.test(k)) throw new InputError('account picker: unset must be variable names');
    delete env[k];
  }
  return env;
}

export function askPicker(argv, verb, req) {
  const args = [...argv.slice(1), verb, '--json'];
  return new Promise((resolve, reject) => {
    const child = execFile(argv[0], args, { encoding: 'utf8', timeout: PICKER_MS, maxBuffer: PICKER_BYTES, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const cap = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        return reject(new InputError(cap ? 'account picker: stdout over the size cap'
          : err.killed ? 'account picker: no answer within the deadline'
          : `account picker ${verb} failed: ${(stderr || err.message).trim().split('\n').at(-1)}`));
      }
      let ans;
      try { ans = JSON.parse(stdout); } catch { return reject(new InputError('account picker: answer is not JSON')); }
      if (!ans || ans.ok === false) return reject(new InputError(`account picker: ${ans?.reason || 'refused'}`));
      if (ans.v !== 1) return reject(new InputError('account picker: answer must set v:1'));
      resolve(ans);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(req));
  });
}

export function pickRequest({ model, deadline, attempted, selection, cause }) {
  const req = { v: 1, purpose: 'work', model, capabilities: ['text'], deadline, attempted };
  if (selection) Object.assign(req, { selection, cause });
  return req;
}
