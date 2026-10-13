// The agents are the user's choice: the tool never picks one. When agent or judge_agent is not set, a terminal is
// asked (a pick list of the supported agents, then the model) and the answer is saved to the config file; any other
// caller, such as an agent, gets one line that says to ask the user, the choices, and the command that saves the answer.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseDocument } from 'yaml';
import { shq, UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import { AGENT_NAME } from './config.mjs';

// The fixed list a terminal picks from (never a PATH scan); any other acp:<target> or byokit:<route> can be typed.
export const CHOICES = ['claude', 'codex', 'opencode', 'pi', 'byokit:opencode-go', 'byokit:chatgpt', 'byokit:claude'];
const LIST = 'claude, codex, opencode, pi, gemini, acp:<target> or byokit:<route> (such as byokit:opencode-go)';
const FLAG = { agent: ['--agent', '--model'], judge_agent: ['--judge-agent', '--judge-model'] };
export const unset = (cfg) => ['agent', 'judge_agent'].filter((k) => !cfg[k].length);
export const interactive = () => !!(process.stdin.isTTY && process.stdout.isTTY);

// The init command that saves the user's answer for the keys that are not set.
export const saveCommand = (keys, dir) => `learn-from-mistakes-axi init ${keys.map((k) => `${FLAG[k][0]} <agent> ${FLAG[k][1]} <model>`).join(' ')}${dir ? ` --dir ${shq(dir)}` : ''}   # with the user's answer`;

export function askError(keys, file, dir) {
  return new UsageError(`ask the user which agent to use: ${keys.join(' and ')} ${keys.length > 1 ? 'are' : 'is'} not set in ${shq(file)}, and the tool never picks one. Choices: ${LIST}; each with its model`,
    saveCommand(keys, dir));
}

// Sets agent/judge_agent and each one's agent_config model in a config file, keeping its comments and other keys.
export function save(file, picks) {
  const doc = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : '');
  if (doc.contents === null) doc.contents = doc.createNode({});
  for (const [key, { agent, model }] of Object.entries(picks)) {
    doc.set(key, agent);
    if (model) doc.setIn(['agent_config', agent, 'model'], model);
  }
  writeFileSync(file, doc.toString());
}

// A terminal picks each unset role and its model; the judge must be another agent than the worker.
export async function pick(keys, cfg) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const lines = rl[Symbol.asyncIterator](); // buffers answers typed or pasted ahead of their question
  const ask = async (q) => {
    process.stderr.write(q);
    const { value, done } = await lines.next();
    if (done) throw new UsageError(`no answer given: ${keys.join(' and ')} not saved`, saveCommand(keys));
    return value.trim();
  };
  const picks = {};
  try {
    for (const key of keys) {
      const role = key === 'agent' ? 'worker (agent)' : 'judge (judge_agent)';
      process.stderr.write(`Which agent runs the ${role}?\n${CHOICES.map((c, i) => `  ${i + 1}) ${c}`).join('\n')}\n  or type acp:<target> or byokit:<route>\n`);
      const worker = picks.agent?.agent ?? cfg.agent[0];
      let agent, model;
      for (;;) {
        const a = await ask('agent: ');
        agent = CHOICES[Number(a) - 1] ?? a;
        if (!AGENT_NAME.test(agent)) process.stderr.write(`${a || '(empty)'} is not one of the choices\n`);
        // agent_config holds one model per agent, so a judge on the worker's agent would judge its own work.
        else if (key === 'judge_agent' && agent === worker) process.stderr.write(`the judge must be another agent than the worker (${worker})\n`);
        else break;
      }
      for (;;) {
        model = await ask(`model for ${agent}: `);
        if (model) break;
        process.stderr.write('a model is needed\n');
      }
      picks[key] = { agent, model };
    }
  } finally { rl.close(); }
  return picks;
}

// Makes sure both roles are set: asks a terminal and saves to file, else throws the ask line. Returns whether it saved.
export async function ensureAgents(cfg, file, dir) {
  const keys = unset(cfg);
  if (!keys.length) return false;
  if (!interactive()) throw askError(keys, file, dir);
  save(file, await pick(keys, cfg));
  process.stderr.write(`saved: ${keys.join(' and ')} in ${file}\n`);
  return true;
}
