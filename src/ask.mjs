// The agents are the user's choice: the tool never picks one. When agent or judge_agent is not set, a terminal is
// asked (a pick list of the supported agents, then the model) and the answer is saved to the config file; any other
// caller, such as an agent, gets one line that says to ask the user, the choices, and the command that saves the answer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseDocument } from 'yaml';
import { shq, UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import { AGENT_NAME, MODEL_RULE, modelOk, PROJECT_FILE } from './config.mjs';
import { INSTALL, readyRoutes, routeModels } from './runners/byokit.mjs';

// The fixed agent CLIs a terminal picks from (never a PATH scan); the BYOKit entries come from BYOKit's own routes
// listing, and a byokit:<route> can always be typed as well.
export const CLIS = ['claude', 'codex', 'opencode', 'pi'];
const LIST = 'claude, codex, opencode, pi or byokit:<route> (such as byokit:opencode-go)';
const FLAG = { agent: ['--agent', '--model'], judge_agent: ['--judge-agent', '--judge-model'] };
// A role is unset when its agent is, or when the agent has no model: both are the user's to set. Only the keys named are
// considered, so a command that starts one role (apply starts the worker) asks for that role alone.
export const unset = (cfg, keys = ['agent', 'judge_agent']) => keys.filter((k) => !cfg[k] || !cfg.agent_config?.[cfg[k]]?.model);
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

const ROLE = { agent: 'worker', judge_agent: 'judge' };
// A saved model replaces the one the agent's other role ran: agent_config holds one model per agent, so that role now
// runs the new model too. Each such role takes one plain note naming the agent and the old and new model, never a refusal.
export const modelNotes = (before, picks) => {
  const notes = new Set();
  for (const [key, { agent, model }] of Object.entries(picks)) {
    const was = model && before.agent_config?.[agent]?.model;
    if (!was || was === model) continue;
    for (const other of Object.keys(ROLE))
      if (other !== key && before[other] === agent) notes.add(`${ROLE[other]} on ${agent} now uses ${model} (was ${was}): one model per agent`);
  }
  return [...notes];
};

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
// one another pick asks. Paused between questions, closed when the command is done.
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
export const closeAsk = () => { reader?.close(); reader = lines = undefined; ended = false; };

// A terminal picks each unset role: its agent when not set, then the model of that agent. A role whose agent is set
// only gets the model question; the agent key is then not written. Both roles may pick one agent: they share its model.
export async function pick(keys, cfg, dir) {
  const ask = async (q) => {
    process.stderr.write(q);
    const { value, done } = await line();
    if (done) throw new UsageError(`no answer given: ${named(cfg, keys).join(' and ')} not saved`, saveCommand(keys, dir));
    return value.trim();
  };
  const picks = {};
  // The BYOKit entries are the routes BYOKit reports as ready; when BYOKit cannot load nothing is known, so the pick
  // still offers the agent CLIs and says how to repair the install, and never fails.
  const choices = [...CLIS, ...(await readyRoutes()).map((r) => `byokit:${r}`)];
  const noRoute = `\n  (BYOKit cannot load: ${INSTALL})`;
  try {
    for (const key of keys) {
      let agent = cfg[key];
      if (!agent) {
        const role = key === 'agent' ? 'worker' : 'judge';
        process.stderr.write(`Which agent runs the ${role}?\n${choices.map((c, i) => `  ${i + 1}) ${c}`).join('\n')}\n  or type byokit:<route>${choices.length === CLIS.length ? noRoute : ''}\n`);
        for (;;) {
          const a = await ask('agent: ');
          agent = choices[Number(a) - 1] ?? a;
          if (!AGENT_NAME.test(agent)) process.stderr.write(`${a || '(empty)'} is not one of the choices\n`);
          else break;
        }
      }
      // agent_config holds one model per agent: a role on the agent the other role just picked takes its model.
      let model = Object.values(picks).find((p) => p.agent === agent)?.model;
      // A BYOKit route lists the models BYOKit exposes for it when it exposes any; the user still types one or picks
      // one by number, and nothing is chosen for them.
      const offered = !model && agent.startsWith('byokit:') ? await routeModels(agent.slice('byokit:'.length)) : undefined;
      if (offered?.length) process.stderr.write(`Models for ${agent}:\n${offered.map((m, i) => `  ${i + 1}) ${m}`).join('\n')}\n`);
      while (!model) {
        const typed = await ask(`model for ${agent}: `);
        const m = offered?.[Number(typed) - 1] ?? typed;
        if (!m) process.stderr.write('a model is needed\n');
        else if (!modelOk(agent, m)) process.stderr.write(`${m} is not ${MODEL_RULE}\n`);
        else model = m;
      }
      picks[key] = { agent, model, set: !cfg[key] };
    }
  } finally { rest(); }
  return picks;
}

// The sessions source is the user's choice too: init offers the agents whose local store exists, none selected, and
// writes the ones named; any other caller gets this command to save the user's answer.
export const sessionsCommand = (dir) => `learn-from-mistakes-axi init --sessions <agent>,<agent>${dir ? ` --dir ${shq(dir)}` : ''}   # with the user's answer`;
export const sessionsAsk = (stores, dir) => `sessions: ask the user which agents' sessions to read${stores.length ? ` (local stores: ${stores.join(', ')})` : ''}, then run ${sessionsCommand(dir)}`;
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

// Makes sure the named roles are set: asks a terminal and saves to file, else throws the ask line. Returns whether it
// saved. The default asks for both; an apply asks for the worker alone, since apply never starts the judge.
export async function ensureAgents(cfg, file, dir, keys = ['agent', 'judge_agent']) {
  const missing = unset(cfg, keys);
  if (!missing.length) return false;
  if (!interactive()) throw askError(cfg, missing, dir);
  const picks = await pick(missing, cfg, dir);
  save(file, picks);
  for (const n of modelNotes(cfg, picks)) process.stderr.write(`note: ${n}\n`);
  process.stderr.write(`saved: ${named(cfg, missing).join(' and ')} in ${file}\n`);
  return true;
}
