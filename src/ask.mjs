// The agents are the user's choice: the tool never picks one. When agent or judge_agent is not set, a terminal is
// asked (a pick list of the supported agents, then the model) and the answer is saved to the config file; any other
// caller, such as an agent, gets one line that says to ask the user, the choices, and the command that saves the answer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseDocument } from 'yaml';
import { shq, UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import { AGENT_NAME, MODEL_RULE, modelOk, PROJECT_FILE } from './config.mjs';
import { CLASH } from './runners/index.mjs';

// The fixed list a terminal picks from (never a PATH scan); a byokit:<route> can be typed as well.
export const CHOICES = ['claude', 'codex', 'opencode', 'pi', 'byokit:opencode-go', 'byokit:chatgpt', 'byokit:claude'];
const LIST = 'claude, codex, opencode, pi or byokit:<route> (such as byokit:opencode-go)';
const FLAG = { agent: ['--agent', '--model'], judge_agent: ['--judge-agent', '--judge-model'] };
// A role is unset when its agent is, or when the agent has no model: both are the user's to set.
export const unset = (cfg) => ['agent', 'judge_agent'].filter((k) => !cfg[k] || !cfg.agent_config?.[cfg[k]]?.model);
// The names of the unset keys as the user reads them: a role's agent, or the model of the agent it already names.
// Two roles on one agent with no model share one name, so it is listed once.
export const named = (cfg, keys) => [...new Set(keys.map((k) => (cfg[k] ? `agent_config.${cfg[k]}.model` : k)))];
export const interactive = () => !!(process.stdin.isTTY && process.stdout.isTTY);

// The init command that saves the user's answer for the keys that are not set.
export const saveCommand = (keys, dir) => `learn-from-mistakes-axi init ${keys.map((k) => `${FLAG[k][0]} <agent> ${FLAG[k][1]} <model>`).join(' ')}${dir ? ` --dir ${shq(dir)}` : ''}   # with the user's answer`;

const projectFile = (dir) => join(dir ?? resolve('.'), PROJECT_FILE);

export function askError(cfg, keys, dir) {
  const names = named(cfg, keys);
  return new UsageError(`ask the user which agent to use: ${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} not set in ${shq(projectFile(dir))}, and the tool never picks one. Choices: ${LIST}; each with its model. Then run the command that stopped again`,
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

// One reader for every question in the process: it buffers answers typed or pasted ahead of a later question, even
// one another pick asks. Paused between questions, it never keeps the process alive.
let reader, lines, ended = false;
const line = () => {
  if (!reader) {
    reader = createInterface({ input: process.stdin, output: process.stderr }).on('close', () => { ended = true; });
    lines = reader[Symbol.asyncIterator]();
  }
  if (!ended) reader.resume();
  return lines.next();
};
const rest = () => { if (!ended) reader?.pause(); };

// A terminal picks each unset role: its agent when not set (the judge must be another agent than the worker), then
// the model of that agent. A role whose agent is set only gets the model question; the agent key is then not written.
export async function pick(keys, cfg, dir) {
  if (cfg.agent && cfg.agent === cfg.judge_agent) throw new UsageError(`judge_agent and agent are both ${cfg.agent}: ${CLASH}; set judge_agent to another agent in ${shq(projectFile(dir))}, then run the command that stopped again`, saveCommand(['judge_agent'], dir));
  const ask = async (q) => {
    process.stderr.write(q);
    const { value, done } = await line();
    if (done) throw new UsageError(`no answer given: ${named(cfg, keys).join(' and ')} not saved`, saveCommand(keys, dir));
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
      let model;
      for (;;) {
        model = await ask(`model for ${agent}: `);
        if (!model) process.stderr.write('a model is needed\n');
        else if (!modelOk(agent, model)) process.stderr.write(`${model} is not ${MODEL_RULE}\n`);
        else break;
      }
      picks[key] = { agent, model, set: !cfg[key] };
    }
  } finally { rest(); }
  return picks;
}

// The sessions source is the user's choice too: init offers the agents whose local store exists, none selected, and
// writes the ones named; any other caller gets this command to save the user's answer.
export const sessionsCommand = (dir) => `learn-from-mistakes-axi init --sessions <agent>,<agent>${dir ? ` --dir ${shq(dir)}` : ''}   # with the user's answer`;
export const sessionsAsk = (stores, dir) => `sessions: ask the user which agents' sessions to read (local stores: ${stores.join(', ')}), then run ${sessionsCommand(dir)}`;
export async function pickSessions(stores, names) {
  process.stderr.write(`Which agents' sessions should the retro read? Local session stores:\n${stores.map((a, i) => `  ${i + 1}) ${a}`).join('\n')}\n`);
  try {
    for (;;) {
      process.stderr.write('numbers or names, comma-separated (empty: none): ');
      const { value, done } = await line();
      if (done || !value.trim()) return [];
      const got = value.trim().split(/[\s,]+/).map((x) => stores[Number(x) - 1] ?? x);
      if (got.every((a) => names.includes(a))) return [...new Set(got)];
      process.stderr.write(`${value.trim()} is not one of ${names.join(', ')}\n`);
    }
  } finally { rest(); }
}

// Makes sure both roles are set: asks a terminal and saves to file, else throws the ask line. Returns whether it saved.
export async function ensureAgents(cfg, file, dir) {
  const keys = unset(cfg);
  if (!keys.length) return false;
  if (!interactive()) throw askError(cfg, keys, dir);
  save(file, await pick(keys, cfg, dir));
  process.stderr.write(`saved: ${named(cfg, keys).join(' and ')} in ${file}\n`);
  return true;
}
