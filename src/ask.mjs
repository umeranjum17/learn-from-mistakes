// The agents are the user's choice: the tool never picks one. When agent or judge_agent is not set, a terminal is
// asked (a pick list of the supported agents, then the model) and the answer is saved to the config file; any other
// caller, such as an agent, gets one line that says to ask the user, the choices, and the command that saves the answer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseDocument } from 'yaml';
import { shq, UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import { AGENT_NAME, MODEL_RULE, modelOk } from './config.mjs';
import KNOWN from './models.json' with { type: 'json' };

// The fixed list a terminal picks from (never a PATH scan); a byokit:<route> can be typed as well.
export const CHOICES = ['claude', 'codex', 'opencode', 'pi', 'byokit:opencode-go', 'byokit:chatgpt', 'byokit:claude'];
const LIST = 'claude, codex, opencode, pi or byokit:<route> (such as byokit:opencode-go)';
const FLAG = { agent: ['--agent', '--model'], judge_agent: ['--judge-agent', '--judge-model'] };
// A role is unset when its agent is, or when the agent has no model: both are the user's to set.
export const unset = (cfg) => ['agent', 'judge_agent'].filter((k) => !cfg[k] || !cfg.agent_config?.[cfg[k]]?.model);
// The names of the unset keys as the user reads them: a role's agent, or the model of the agent it already names.
export const named = (cfg, keys) => keys.map((k) => (cfg[k] ? `agent_config.${cfg[k]}.model` : k)).join(' and ');
export const interactive = () => !!(process.stdin.isTTY && process.stdout.isTTY);

// The init command that saves the user's answer for the keys that are not set.
export const saveCommand = (keys, dir) => `learn-from-mistakes-axi init ${keys.map((k) => `${FLAG[k][0]} <agent> ${FLAG[k][1]} <model>`).join(' ')}${dir ? ` --dir ${shq(dir)}` : ''}   # with the user's answer`;

export function askError(cfg, keys, file, dir) {
  return new UsageError(`ask the user which agent to use: ${named(cfg, keys)} ${keys.length > 1 ? 'are' : 'is'} not set in ${shq(file)}, and the tool never picks one. Choices: ${LIST}; each with its model. Then run the command that stopped again`,
    saveCommand(keys, dir));
}

// Sets agent/judge_agent and each one's agent_config model in a config file, keeping its comments and other keys.
export function save(file, picks) {
  const doc = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : '');
  if (doc.contents === null) doc.contents = doc.createNode({});
  for (const [key, { agent, model, set }] of Object.entries(picks)) {
    if (set) doc.set(key, agent);
    if (model) {
      if (!doc.get('agent_config')) doc.set('agent_config', doc.createNode({}));
      doc.setIn(['agent_config', agent, 'model'], model);
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, doc.toString());
}

// A terminal picks each unset role: its agent when not set (the judge must be another agent than the worker), then
// the model of that agent. A role whose agent is set only gets the model question; the agent key is then not written.
export async function pick(keys, cfg) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const lines = rl[Symbol.asyncIterator](); // buffers answers typed or pasted ahead of their question
  const ask = async (q) => {
    process.stderr.write(q);
    const { value, done } = await lines.next();
    if (done) throw new UsageError(`no answer given: ${named(cfg, keys)} not saved`, saveCommand(keys));
    return value.trim();
  };
  const picks = {};
  try {
    for (const key of keys) {
      let agent = cfg[key];
      if (!agent) {
        const [role, other, otherRole] = key === 'agent'
          ? ['worker (agent)', cfg.judge_agent, 'judge']
          : ['judge (judge_agent)', picks.agent?.agent ?? cfg.agent, 'worker'];
        process.stderr.write(`Which agent runs the ${role}?\n${CHOICES.map((c, i) => `  ${i + 1}) ${c}`).join('\n')}\n  or type byokit:<route>\n`);
        for (;;) {
          const a = await ask('agent: ');
          agent = CHOICES[Number(a) - 1] ?? a;
          if (!AGENT_NAME.test(agent)) process.stderr.write(`${a || '(empty)'} is not one of the choices\n`);
          // agent_config holds one model per agent, so two roles on one agent would judge their own work.
          else if (agent === other) process.stderr.write(`the ${key === 'agent' ? 'worker' : 'judge'} must be another agent than the ${otherRole} (${other})\n`);
          else break;
        }
      }
      const known = KNOWN[agent.split(':')[0]] ?? [];
      if (known.length) process.stderr.write(`Models for ${agent}:\n${known.map((m, i) => `  ${i + 1}) ${m}`).join('\n')}\n`);
      let model;
      for (;;) {
        const typed = await ask(`model for ${agent}${known.length ? ' (a number, or a model id)' : ''}: `);
        model = known.length && /^\d+$/.test(typed) ? known[Number(typed) - 1] : typed;
        if (!model) process.stderr.write(typed ? `${typed} is not one of the models listed\n` : 'a model is needed\n');
        else if (!modelOk(agent, model)) process.stderr.write(`${model} is not ${MODEL_RULE}\n`);
        else break;
      }
      picks[key] = { agent, model, set: !cfg[key] };
    }
  } finally { rl.close(); }
  return picks;
}

// Makes sure both roles are set: asks a terminal and saves to file, else throws the ask line. Returns whether it saved.
export async function ensureAgents(cfg, file, dir) {
  const keys = unset(cfg);
  if (!keys.length) return false;
  if (!interactive()) throw askError(cfg, keys, file, dir);
  save(file, await pick(keys, cfg));
  process.stderr.write(`saved: ${named(cfg, keys)} in ${file}\n`);
  return true;
}
