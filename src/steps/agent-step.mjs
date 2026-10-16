// The harness every agent step runs through. The step's role (worker or judge) is the agent the user set in the config
// (agent or judge_agent, with its agent_config model); the run never picks one: a role that is not set, has no model, or
// does not resolve to a ready agent, fails the step. It calls it in the run dir with the step's prompt and the bundle, and checks the answer with the step's
// own check. An answer that fails the check is sent back once with the problems; a second one fails the step with them.
// Each call is one `invocations` row, with the agent's process group while it runs and the tokens it reported; a run
// makes at most caps.invocations calls.
import { InputError } from '../../bin/learn-from-mistakes-axi.mjs';
import { readBundle } from '../check.mjs';
import { startTime } from '../proc.mjs';
import { call, chooseFix, detect, KEY, resolveRoles } from '../runners/index.mjs';

const iso = () => new Date().toISOString();
const LENGTH_STOP = /\b(length|max[_-]?output[_-]?tokens?|max[_-]?tokens?|token[_-]?limit|truncated|incomplete)\b/i;

// Returns the checked JSON object. `check(value, attempt, stop)` returns the problems with the answer, each naming a field and the
// rule it broke (the plain-language rule names the sentence and the single offending word, never a longer passage);
// `stop` is the runner's reported stop reason (null when none), so a step whose answer must be whole can refuse a reply
// the output limit cut off. A problem a retry cannot fix (a cut reply: the same limit applies again) is thrown as a fatal
// InputError instead, which ends the step at once.
export async function agentStep(cfg, db, id, dir, { step, role, prompt, check, log, bundle = true }) {
  const key = KEY[role];
  const r = (await resolveRoles(cfg, detect(cfg)))[role];
  const fix = chooseFix(cfg, key, r.runner);
  const problem = r.problem || (!r.model && `no model set in agent_config for ${r.runner}`);
  if (problem) throw new InputError(`${role}: ${problem}; ${fix}`);
  const data = bundle ? `\n\n${readBundle(dir, id)}` : '';
  const invalid = db.prepare(`UPDATE invocations SET exit_status = 'invalid' WHERE id = ?`);
  let ask = prompt, problems;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const got = await invoke(cfg, db, id, dir, { step, role, ...r }, `${ask}${data}`, log);
    const stop = got.stop ?? null;
    if (!got.value && stop && LENGTH_STOP.test(stop)) throw new InputError(`the ${role}'s reply was cut off (the reply stopped at ${JSON.stringify(stop)}); the ${role} hit its output limit`, `shorten the change or raise the model's output limit, then try again`);
    problems = got.value ? check(got.value, attempt, stop) : [got.text.trim() ? 'the answer holds no JSON object' : 'the answer is empty'];
    if (!problems.length) return got.value;
    invalid.run(got.row);
    log(`${role} answer ${attempt} is not valid: ${problems.join('; ')}`);
    ask = `${prompt}\n\nYour last answer was not valid: ${problems.join('; ')}. Answer again with one JSON object that fixes this.`;
  }
  throw new InputError(`the ${role}'s answer is not valid after one retry: ${problems.join('; ')}`);
}

async function invoke(cfg, db, id, dir, { step, role, runner, model }, prompt, log) {
  const used = db.prepare('SELECT count(*) AS n FROM invocations WHERE run_id = ?').get(id).n;
  if (used >= cfg.caps.invocations) throw new InputError(`caps.invocations reached: run ${id} already made ${used} agent calls`);
  const row = db.prepare('INSERT INTO invocations (run_id, step, role, runner, model, marker, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, step, role, runner, model, `lfm-run:${id}:${step}`, iso()).lastInsertRowid;
  const end = db.prepare('UPDATE invocations SET completed_at = ?, exit_status = ?, session_id = ?, tokens_in = ?, tokens_out = ? WHERE id = ?');
  const who = `${role} ${runner}${model ? ` ${model}` : ''}`;
  const target = runner.match(/^acp:(.+)/)?.[1];
  let got;
  try {
    got = await call(cfg, { runner: target ? 'acp' : runner, target, model, dir, runId: id, step, prompt, empty: true, // an empty answer is a bad answer: sent back once
      onSpawn: (pgid) => db.prepare('UPDATE invocations SET child_pgid = ?, child_started_at = ? WHERE id = ?').run(pgid, startTime(pgid), row) });
  } catch (e) {
    end.run(iso(), 'error', null, null, null, row);
    throw e;
  }
  end.run(iso(), 'ok', got.session_id, got.tokens_in, got.tokens_out, row);
  log(`${who}: answered${got.tokens_in == null ? '' : `, ${got.tokens_in} tokens in, ${got.tokens_out} out`}`);
  return { ...got, row };
}
