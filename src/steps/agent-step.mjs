// The harness every agent step runs through. The step's role (worker or judge) is the agent the user set in the config
// (agent or judge_agent, with its agent_config model); the run never picks one: a role that is not set, has no model, or
// does not resolve to a ready agent, fails the step. It calls it in the run dir with the step's prompt and the bundle, and checks the answer with the step's
// own check. An answer that fails the check is sent back once with the problems; a second one fails the step with them.
// Each call is one `invocations` row, with the agent's process group while it runs and the tokens it reported; a run
// makes at most caps.invocations calls.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InputError } from '../../bin/learn-from-mistakes-axi.mjs';
import { startTime } from '../proc.mjs';
import { call, detect, fileOf, KEY, resolveRole } from '../runners/index.mjs';

const iso = () => new Date().toISOString();

// Returns the checked JSON object. `check(value)` returns the problems with the answer, each naming a field and the rule
// it broke, never the agent's own text.
export async function agentStep(cfg, db, id, dir, { step, role, prompt, check, log }) {
  const key = KEY[role], fix = `set ${key} and its agent_config model in ${fileOf(cfg, key)} to an agent you have; the run never picks one`;
  const r = await resolveRole(cfg, role, detect(cfg));
  const problem = r.problem || (!r.model && `no model set in agent_config for ${r.runner}`);
  if (problem) throw new InputError(`${role}: ${problem}; ${fix}`);
  const bundle = readFileSync(join(dir, 'bundle.md'), 'utf8');
  const invalid = db.prepare(`UPDATE invocations SET exit_status = 'invalid' WHERE id = ?`);
  let ask = prompt, problems;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const got = await invoke(cfg, db, id, dir, { step, role, ...r }, `${ask}\n\n${bundle}`, log);
    problems = got.value ? check(got.value) : [got.text.trim() ? 'the answer holds no JSON object' : 'the answer is empty'];
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
  let got;
  try {
    got = await call(cfg, { runner, model, dir, runId: id, step, prompt, empty: true, // an empty answer is a bad answer: sent back once
      onSpawn: (pgid) => db.prepare('UPDATE invocations SET child_pgid = ?, child_started_at = ? WHERE id = ?').run(pgid, startTime(pgid), row) });
  } catch (e) {
    end.run(iso(), 'error', null, null, null, row);
    throw e;
  }
  end.run(iso(), 'ok', got.session_id, got.tokens_in, got.tokens_out, row);
  log(`${who}: answered${got.tokens_in == null ? '' : `, ${got.tokens_in} tokens in, ${got.tokens_out} out`}`);
  return { ...got, row };
}
