// init: write the global $LFM_HOME/config.yaml and a project's .learn-from-mistakes.yaml, each once and never over a
// file that exists. The global file holds the agent keys, fully commented, in no-mistakes' shape; the project file
// holds the sources the registry's detect hooks find and the agents the user chose.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { InputError, shq, shown, stateDir, UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import { interactive, pickSessions, save, saveCommand, sessionsAsk, unset } from './ask.mjs';
import { AGENT_RULE, expand, globalFile, loadConfig, loadGlobal, PROJECT_FILE, SOURCES } from './config.mjs';
import { CLASH, configuredRunners, detect, KEY, resolveRoles, runnerKey, RUNNERS } from './runners/index.mjs';
import { READERS, stores } from './sources/sessions.mjs';

const SKILL_SRC = fileURLToPath(new URL('../skills/learn-from-mistakes/SKILL.md', import.meta.url));
// The flags --reconfigure re-applies to an existing config; the ignored line names the flag only for these.
export const RECONFIGURABLE = ['--agent', '--model', '--judge-agent', '--judge-model', '--sessions'];
const FIX = (flag) => `learn-from-mistakes-axi init ${flag} <agent> ...   # an installed agent CLI or byokit:<route>; agents --test <agent> checks one`;

// Installs the packaged skill for the agents the user configured (agent and judge_agent), each into its own global
// skills dir (the runner skills() paths, as `npx skills` lays them out); `--project-skill` writes the project's
// .claude/skills and .agents/skills instead, `--no-skill` writes none. Each real file is written once: roots that
// resolve to one dir share it, and a file holding the same bytes is left alone. A failed write is a skip, never fatal.
export function installSkills(cfg, agents, dir, opts) {
  if (opts['no-skill']) return { written: [], updated: [], failed: [], roots: 0 };
  const roots = opts['project-skill']
    ? [join(dir, '.claude', 'skills'), join(dir, '.agents', 'skills')]
    : [...new Set([cfg.agent, cfg.judge_agent].filter(Boolean))].flatMap((name) => {
      const key = runnerKey(name);
      if (name.startsWith('byokit:') || !RUNNERS[key]?.skills) return [];
      return agents.find((x) => x.runner === key)?.usable ? [RUNNERS[key].skills(process.env)] : [];
    });
  const text = readFileSync(SKILL_SRC, 'utf8');
  const written = [], updated = [], failed = [], done = new Set();
  for (const root of roots) {
    try {
      const target = join(root, 'learn-from-mistakes');
      mkdirSync(target, { recursive: true });
      const real = realpathSync(target);
      if (done.has(real)) continue;
      done.add(real);
      const file = join(target, 'SKILL.md');
      const exists = existsSync(file);
      if (exists && readFileSync(file, 'utf8') === text) continue;
      writeFileSync(file, text);
      written.push(file);
      if (exists) updated.push(file);
    } catch (e) { failed.push(`${root}: ${e.message}`); }
  }
  return { written, updated, failed, roots: roots.length };
}
const scalar = (v) => JSON.stringify(v); // a JSON string is a YAML scalar
const flow = (o) => `{ ${Object.entries(o).map(([k, v]) => `${k}: ${scalar(v)}`).join(', ')} }`;
// Starter causes for any project, so the worker has causes to label with, not only "other": each tags the session events
// of one signal. Edit or replace them; init writes them only into a project file it creates.
const STARTER = {
  'test-failed': ['test_fail', 'a test or check failed: the change went on before its tests passed'],
  'command-failed': ['nonzero_exit', 'a shell command failed: a wrong path, flag or argument, or a tool that is not installed'],
  'tool-misused': ['tool_error', 'a tool call failed: wrong input, or a file that was not read first or has changed'],
  'user-corrected': ['correction', 'the user corrected the agent: it misread the ask or skipped a stated rule'],
};

const globalText = `# learn-from-mistakes global configuration
# A project's .learn-from-mistakes.yaml may override agent, judge_agent, agent_config,
# agent_timeout and allow_premium; auto_fix and the other keys here are global-only.

# Agent that runs the retro's agent steps. Every retro starts it. You set it: the tool never
# picks one, and asks when it is not set (init --agent <agent> --model <model> saves the answer).
# It is one agent: the tool never tries another when this one is not ready.
# Options: ${AGENT_RULE}
# byokit:<route> calls a model through BYOKit with no agent CLI: a sign-in plan (chatgpt, claude)
# or a plan key route such as opencode-go (learn-from-mistakes-axi agents --test byokit:<route>
# checks one)
# agent: claude

# Agent that checks the worker's output. Same values as agent; its agent must differ from the
# worker's (agent_config holds one model per agent): the judge never judges its own work.
# judge_agent: codex

# Model and reasoning effort per agent. Effort is one of minimal, low, medium, high, xhigh, max; it
# maps to --effort for claude, -c model_reasoning_effort for codex, --variant for opencode and
# --thinking for pi; gemini, acp:<target> and byokit:<route> take no effort. An agent with no
# model here is asked for one: the tool never lets its CLI pick its own model.
# agent_config:
#   <agent>:
#     model: <model>
#     effort: low
#   "byokit:<route>":
#     model: <model>

# Maximum wall-clock time for one agent call. A stalled agent is stopped and the step fails with
# its cause.
# agent_timeout: "20m"

# Premium models (Opus, Sonnet, Sol) are refused unless this is true.
# allow_premium: false

# auto_fix: 0   # kept fixes a run applies unless answered Skip, each on its own branch;
#   0 proposes only
# Override native agent binary paths (optional, global only)
# agent_path_override:
#   claude: /usr/local/bin/claude
#   codex: /opt/codex

# Extra native agent CLI flags (optional, global only)
# agent_args_override:
#   codex:
#     - -c
#     - service_tier="priority"

# Optional path to the user-installed acpx binary for acp:<target> agents (global only)
# acpx_path: acpx

# Keep each project's run state here, one dir per project name, instead of
# <project>/.lfm (global only)
# state_root: ~/.learn-from-mistakes/state
`;

// Writes the global file and the project config when each is missing; a file that exists is never rewritten, except
// that the agents the user chose (--agent, --judge-agent and their --model flags, or a terminal's pick) are saved into a
// project config that does not set them yet. The tool never picks an agent: with none chosen, a gap says to ask the user.
// Either way it makes the state dir and returns the config as loaded, plus its gaps: a role that is not set or does not
// resolve, or a detected source the config lacks.
export async function init(dir, opts) {
  const file = join(dir, PROJECT_FILE);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`${dir}: not a directory`, 'learn-from-mistakes-axi init --dir <project>   # an existing project dir');
  const global = globalFile(), globalWritten = !existsSync(global), written = !existsSync(file);
  const found = {}, skipped = [];
  for (const [type, mod] of Object.entries(SOURCES)) {
    try {
      Object.assign(found, await mod.detect?.(dir));
    } catch (e) { skipped.push(`${type}: ${e.message}`); }
  }
  if (opts.firstmate) { // opt-in only: a Firstmate home is never detected
    if (!statSync(opts.firstmate, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`--firstmate ${opts.firstmate}: not a directory`, 'learn-from-mistakes-axi init --firstmate <home>   # the Firstmate home folder that holds state/');
    found.home = { type: 'firstmate', path: opts.firstmate };
  }
  // The keys the flags choose: on a new project config, each one given; on one that exists, only a key the project file
  // does not set yet (its agent, or its agent's model), so a global agent never blocks a project override -- unless
  // --reconfigure says the flags re-apply: they replace those keys in the existing config, every other key and comment stays.
  const before = written ? loadGlobal() : loadConfig(dir), here = (k) => before.from[k] === file;
  const chosen = {}, ignored = [];
  for (const [key, flag, model] of [['agent', 'agent', 'model'], ['judge_agent', 'judge-agent', 'judge-model']]) {
    if (!opts[flag]) continue;
    const agent = opts[flag], takeAgent = written || opts.reconfigure || !here(key);
    const takeModel = !!opts[model] && (opts.reconfigure || (!here(`agent_config.${agent}.model`) && (takeAgent || before[key] === agent)));
    if (takeAgent || takeModel) chosen[key] = { agent, model: takeModel ? opts[model] : undefined, set: takeAgent };
    if (!takeAgent) ignored.push(`--${flag}`);
    if (opts[model] && !takeModel) ignored.push(`--${model}`);
  }
  if (!written && opts['no-excerpts']) ignored.push('--no-excerpts');
  // The sessions source: the agents --sessions names, or a terminal's pick of the local stores (none selected); else a gap.
  const names = Object.keys(READERS), local = stores();
  const has = !written && Object.values(before.sources).some((s) => s.type === 'sessions');
  let reads = opts.sessions?.split(',').map((a) => a.trim()), asked = opts.sessionsAsked === true;
  if (reads && !reads.every((a) => names.includes(a))) throw new UsageError(`--sessions ${shown(opts.sessions)} must list agents by name: ${names.join(', ')}`, 'learn-from-mistakes-axi init --sessions claude,pi   # the agents whose sessions the user wants read');
  if (reads && has && !opts.reconfigure) { ignored.push('--sessions'); reads = undefined; }
  if (!reads && !has && local.length && !opts.y && interactive() && !asked) { reads = await pickSessions(local, names); asked = true; opts.sessionsAsked = true; }
  // Only the roles the user set now need probing: the config's, plus the agents these flags choose. No other
  // agent CLI is run and no other login store is read.
  const agents = detect(before, [...new Set([...configuredRunners(before), ...configuredRunners({ agent: chosen.agent?.agent, judge_agent: chosen.judge_agent?.agent })])]);
  // A chosen role that is not usable, or a chosen judge on the worker's identity, is refused before any file is written.
  if (Object.keys(chosen).length) {
    const want = { ...before, agent_config: structuredClone(before.agent_config) };
    for (const [key, c] of Object.entries(chosen)) {
      if (c.set) want[key] = c.agent;
      if (c.model) want.agent_config[c.agent] = { ...want.agent_config[c.agent], model: c.model };
    }
    const { worker, judge } = await resolveRoles(want, agents);
    if (chosen.agent && worker.problem) throw new InputError(`worker: ${worker.problem}`, worker.fix ?? FIX('--agent'));
    if ((chosen.agent || chosen.judge_agent) && judge.problem === CLASH) {
      // One agent in both roles has one model, whatever --model and --judge-model say: the judge needs another agent.
      const one = want.agent === want.judge_agent, model = (m) => (m ? shq(m) : '<model>');
      throw new UsageError(`judge: ${one ? `the worker and the judge are both ${want.agent}, and agent_config holds one model per agent, so the judge would judge its own work` : judge.problem}`,
        `learn-from-mistakes-axi init --agent ${shq(want.agent)} --model ${model(chosen.agent?.model ?? before.agent_config[want.agent]?.model)} --judge-agent <another agent> --judge-model <model>${opts.dir ? ` --dir ${shq(opts.dir)}` : ''}   # ask the user which other agent runs the judge`);
    }
    if (chosen.judge_agent && judge.problem) throw new InputError(`judge: ${judge.problem}`, judge.fix ?? FIX('--judge-agent'));
  }
  if (globalWritten) {
    try { mkdirSync(dirname(global), { recursive: true }); writeFileSync(global, globalText, { flag: 'wx' }); }
    catch (e) { throw new UsageError(`${global}: cannot write (${e.code})`, `ls -la ${dirname(global)}   # init writes config.yaml there, or set LFM_HOME`); }
  }
  if (written) {
    try {
      writeFileSync(file, `# written by learn-from-mistakes-axi init
name: ${scalar(basename(dir))}
# The agent keys come from $LFM_HOME/config.yaml (default ~/.learn-from-mistakes/config.yaml); set
# one here to override it for this project. The tool never picks an agent: set agent and
# judge_agent, each with its model.
# agent: claude   # or codex, opencode, pi, gemini, acp:<target>, byokit:<route>
# judge_agent: codex   # its agent must differ from the worker's (one model per agent)
# agent_config: { <agent>: { model: <model>, effort: low } }
# agent_timeout: "20m"
excerpts: ${opts['no-excerpts'] ? 'off' : 'on'}   # on: the worker and judge see redacted record excerpts; off: pointers and counts only
# A markdown-log source with review: true is a review log: its records do not count as defects.
sources:${Object.keys(found).length ? '' : ' {}'}
${Object.entries(found).map(([id, s]) => `  ${id}: ${flow(s)}\n`).join('')}`, { flag: 'wx' });
    } catch (e) { throw new UsageError(`${file}: cannot write (${e.code})`, `ls -la ${dir}   # init writes ${PROJECT_FILE} there`); }
  }
  if (Object.keys(chosen).length) save(file, chosen);
  if (!written && opts.firstmate && !Object.values(before.sources).some((s) => s.type === 'firstmate' && s.path === opts.firstmate)) {
    // the opt-in adds the source to a config that exists, unless it has another home or a source named home
    if (Object.hasOwn(before.sources, 'home') || Object.values(before.sources).some((s) => s.type === 'firstmate')) ignored.push('--firstmate');
    else {
      const doc = parseDocument(readFileSync(file, 'utf8'));
      if (!doc.get('sources')) doc.set('sources', doc.createNode({}));
      doc.setIn(['sources', 'home'], doc.createNode({ type: 'firstmate', path: opts.firstmate }, { flow: true }));
      try { writeFileSync(file, doc.toString({ lineWidth: 90 })); }
      catch (e) { throw new UsageError(`${file}: cannot write (${e.code})`, `ls -la ${dir}   # init writes ${PROJECT_FILE} there`); }
    }
  }
  if (reads?.length) {
    const doc = parseDocument(readFileSync(file, 'utf8'));
    if (!doc.get('sources')) doc.set('sources', doc.createNode({}));
    doc.setIn(['sources', before.sources?.sessions && !opts.reconfigure ? 'agent-sessions' : 'sessions'], doc.createNode({ type: 'sessions', agents: [...new Set(reads)] }, { flow: true }));
    try { writeFileSync(file, doc.toString({ lineWidth: 90 })); }
    catch (e) { throw new UsageError(`${file}: cannot write (${e.code})`, `ls -la ${dir}   # init writes ${PROJECT_FILE} there`); }
  }
  let cfg = loadConfig(dir);
  if (written) { // each match names the config's sessions source; with none, the causes are for the worker's labels only
    const doc = parseDocument(readFileSync(file, 'utf8'));
    const sessions = Object.keys(cfg.sources).find((id) => cfg.sources[id].type === 'sessions');
    const pair = doc.createPair('causes', Object.fromEntries(Object.entries(STARTER).map(([id, [signal, description]]) => [id, { description, ...(sessions && { match: { source: sessions, signal } }) }])));
    pair.key.commentBefore = ' Starter causes, written by init: the worker labels records with them. Edit, add or remove them.';
    doc.contents.items.push(pair);
    try { writeFileSync(file, doc.toString({ lineWidth: 90 })); }
    catch (e) { throw new UsageError(`${file}: cannot write (${e.code})`, `ls -la ${dir}   # init writes ${PROJECT_FILE} there`); }
    cfg = loadConfig(dir);
  }
  stateDir(cfg);
  const missing = unset(cfg);
  const { worker, judge } = await resolveRoles(cfg, agents);
  const { written: skills, updated: skills_updated, failed: skills_skipped, roots: skills_roots } = installSkills(cfg, agents, dir, opts);
  const gaps = [...(missing.length ? [`agents: ask the user which agent and model to use, then run ${saveCommand(missing, opts.dir)}`] : []),
    ...Object.entries({ worker, judge }).filter(([name, r]) => r.problem && !missing.includes(KEY[name])).map(([name, r]) => `${name}: ${r.problem}${r.fix ? `; ${r.fix}` : ''}`),
    ...(!has && !reads?.length && !asked ? [sessionsAsk(local, opts.dir)] : []),
    ...(Object.keys(cfg.causes).length ? [] : [`causes: none in ${PROJECT_FILE}, so every label is other: add a causes key with a description per cause`]),
    ...Object.entries(found).filter(([, s]) => !Object.values(cfg.sources).some((c) => c.type === s.type && (!s.path || c.path === expand(s.path, dir))))
      .map(([id, s]) => `sources: ${s.type} found${s.path ? ` at ${s.path}` : ''}, not configured (add it as ${id})`)];
  return {
    config: file, status: written ? 'written' : 'already set up', global, global_status: globalWritten ? 'written' : 'kept', ignored,
    causes: Object.keys(cfg.causes),
    worker: { runner: worker.runner, model: worker.model }, judge: { runner: judge.runner, model: judge.model }, workerBin: worker.bin, judgeBin: judge.bin, missing,
    excerpts: cfg.excerpts, sources: Object.fromEntries(Object.entries(cfg.sources).map(([id, s]) => [id, s.path ? { type: s.type, path: s.path } : { type: s.type }])),
    gaps, skipped, skills, skills_updated, skills_skipped, skills_roots,
  };
}
