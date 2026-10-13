// init: write the global $LFM_HOME/config.yaml and a project's .learn-from-mistakes.yaml, each once and never over a
// file that exists. The global file holds the agent keys, fully commented, in no-mistakes' shape; the project file
// holds the sources the registry's detect hooks find, and may override the agent keys.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { InputError, stateDir, UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import { AGENT_DEFAULTS, expand, globalFile, loadConfig, loadGlobal, PROJECT_FILE, SOURCES } from './config.mjs';
import { AUTO_ROUTE, detect, resolveRoles } from './runners/index.mjs';

const ID = { 'markdown-log': 'log', 'no-mistakes': 'gate', github: 'prs' }; // the id a detected source is written under; else its type
const FIX = 'learn-from-mistakes-axi agents   # the agent CLIs found, and why one is not usable';
const scalar = (v) => JSON.stringify(v); // a JSON string is a YAML scalar
const flow = (o) => `{ ${Object.entries(o).map(([k, v]) => `${k}: ${scalar(v)}`).join(', ')} }`;

// A function: config.mjs and this file import each other, so AGENT_DEFAULTS is read at call time.
const globalText = () => `# learn-from-mistakes global configuration
# A project's .learn-from-mistakes.yaml may override agent, judge_agent, agent_config, agent_timeout and
# allow_premium; the other keys here are global-only.

# Agent that runs the retro's agent steps. Every retro starts it. This may also be an ordered fallback
# list, for example: agent: [codex, claude]
# Options: auto, claude, codex, opencode, pi, gemini, acp:<target>, byokit:<route>
# "auto" picks ${AUTO_ROUTE} (OpenCode Go through BYOKit) when OPENCODE_API_KEY is set, then the first
# usable agent CLI in this order: claude, codex, opencode, pi
# byokit:<route> calls a model through BYOKit with no agent CLI: a sign-in plan (chatgpt, claude) or a
# plan key route such as opencode-go (learn-from-mistakes-axi agents lists them)
agent: auto

# Agent that checks the worker's output. Same values as agent. "auto" takes the first candidate whose
# agent and model differ from the worker's: the judge never judges its own work.
judge_agent: auto

# Model and reasoning effort per agent. Effort is one of minimal, low, medium, high, xhigh, max; it maps
# to --effort for claude, -c model_reasoning_effort for codex, --variant for opencode and --thinking for
# pi; gemini, acp:<target> and byokit:<route> take no effort. An agent with no model here runs on the
# model its CLI picks, which may be a premium one.
agent_config:
${Object.entries(AGENT_DEFAULTS).map(([a, c]) => `  ${a.includes(':') ? scalar(a) : a}:\n    model: ${c.model}\n`).join('')}#
# Examples:
#   pi:
#     model: <provider>/<model>
#     effort: low
#   "acp:<target>":
#     model: <model>

# Maximum wall-clock time for one agent call. A stalled agent is stopped and the step fails with its cause.
agent_timeout: "20m"

# Premium models (Opus, Sonnet, Sol) are refused unless this is true.
# allow_premium: false

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

# Keep each project's run state here, one dir per project name, instead of <project>/.lfm (global only)
# state_root: ~/.learn-from-mistakes/state
`;

// Writes the global file and the project config when each is missing; a project config that exists is left as it
// is, and the flags that would have changed it are returned as ignored. Either way it makes the state dir and returns
// the config as loaded, plus its gaps: a role that does not resolve, or a detected source the config lacks.
export async function init(dir, opts) {
  const file = join(dir, PROJECT_FILE);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`${dir}: not a directory`, 'learn-from-mistakes-axi init --dir <project>   # an existing project dir');
  const changes = ['agent', 'judge-agent', 'no-excerpts'].filter((k) => opts[k]).map((k) => `--${k}`);
  const global = globalFile(), globalWritten = !existsSync(global);
  // Written after the refusals below, so a refused init writes no file; the defaults it resolves with are the same.
  const writeGlobal = () => {
    if (!globalWritten) return;
    try { mkdirSync(dirname(global), { recursive: true }); writeFileSync(global, globalText(), { flag: 'wx' }); }
    catch (e) { throw new UsageError(`${global}: cannot write (${e.code})`, `ls -la ${dirname(global)}   # init writes config.yaml there, or set LFM_HOME`); }
  };
  const found = {}, skipped = [];
  for (const [type, mod] of Object.entries(SOURCES)) {
    try {
      const entry = await mod.detect?.(dir);
      if (entry) found[ID[type] ?? type] = entry;
    } catch (e) { skipped.push(`${type}: ${e.message}`); }
  }
  const base = loadGlobal(), agents = detect(base);
  const written = !existsSync(file);
  if (written) {
    const want = { ...base, ...(opts.agent && { agent: [opts.agent] }), ...(opts['judge-agent'] && { judge_agent: [opts['judge-agent']] }) };
    const { worker, judge } = await resolveRoles(want, agents);
    const pinned = `learn-from-mistakes-axi init --agent <agent> --judge-agent ${opts['judge-agent']}   # a worker on another agent`;
    // A pinned judge with no worker that differs from it is refused, as is a judge pinned onto the worker's identity.
    if (worker.problem) {
      if (opts['judge-agent'] && !opts.agent && judge.bin) throw new UsageError(`worker: ${worker.problem}`, pinned);
      throw new InputError(`worker: ${worker.problem}`, FIX);
    }
    if (judge.problem && !judge.bin) throw new InputError(`judge: ${judge.problem}`, FIX);
    // An auto judge with no second identity is written and reported; a judge the user pinned onto the worker is refused.
    if (judge.problem && opts['judge-agent']) throw new UsageError(`judge: ${judge.problem}`, pinned);
    writeGlobal();
    const set = (key, value, example) => (value ? `${key}: ${scalar(value)}\n` : `# ${key}: ${example}\n`);
    try {
      writeFileSync(file, `# written by learn-from-mistakes-axi init
name: ${scalar(basename(dir))}
# The agent keys come from $LFM_HOME/config.yaml (default ~/.learn-from-mistakes/config.yaml); set one here to
# override it for this project.
${set('agent', opts.agent, 'auto   # or claude, codex, opencode, pi, gemini, acp:<target>, byokit:<route>, or a list')}${
  set('judge_agent', opts['judge-agent'], 'auto   # its agent and model must differ from the worker\'s')}# agent_config: { claude: { model: claude-haiku-5-5, effort: low } }
# agent_timeout: "20m"
excerpts: ${opts['no-excerpts'] ? 'off' : 'on'}   # on: the worker and judge see redacted record excerpts; off: pointers and counts only
sources:${Object.keys(found).length ? '' : ' {}'}
${Object.entries(found).map(([id, s]) => `  ${id}: ${flow(s)}\n`).join('')}`, { flag: 'wx' });
    } catch (e) { throw new UsageError(`${file}: cannot write (${e.code})`, `ls -la ${dir}   # init writes ${PROJECT_FILE} there`); }
  }
  else writeGlobal();
  const cfg = loadConfig(dir);
  stateDir(cfg);
  const { worker, judge } = await resolveRoles(cfg, agents);
  const gaps = [...Object.entries({ worker, judge }).filter(([, r]) => r.problem).map(([name, r]) => `${name}: ${r.problem}`),
    ...Object.entries(found).filter(([, s]) => !Object.values(cfg.sources).some((c) => c.type === s.type && (!s.path || c.path === expand(s.path, dir))))
      .map(([id, s]) => `sources: ${s.type} found${s.path ? ` at ${s.path}` : ''}, not configured (add it as ${id})`)];
  return {
    config: file, status: written ? 'written' : 'already set up', global, global_status: globalWritten ? 'written' : 'kept', ignored: written ? [] : changes,
    worker: { runner: worker.runner, model: worker.model }, judge: { runner: judge.runner, model: judge.model }, workerBin: worker.bin, judgeBin: judge.bin, anyUsable: agents.some((a) => a.usable),
    excerpts: cfg.excerpts, sources: Object.fromEntries(Object.entries(cfg.sources).map(([id, s]) => [id, s.path ? { type: s.type, path: s.path } : { type: s.type }])),
    gaps, skipped,
  };
}
