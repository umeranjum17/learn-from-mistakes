// doctor: one check per line, ok, warn or fail, and the fix for each one that is not ok. It only reads: it makes no
// state dir, and calls no agent unless --live (one call per role, which costs tokens). Login checks read a status and
// never print it, so no credential text reaches the output; they never refresh a token.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import { loadConfig, PROJECT_FILE, SOURCES } from './config.mjs';
import { agents, binName, detect, INSTALL, MODELS, resolveRoles, RUNNERS, same, which } from './runners/index.mjs';

const PREMIUM = /(^|[^a-z])(opus|sonnet|sol)([^a-z]|$)/i;
const SKILL = fileURLToPath(new URL('../skills/learn-from-mistakes/SKILL.md', import.meta.url));

export async function doctor(dir, opts) {
  const checks = [];
  const add = (level, label, detail, fix) => checks.push({ level, label, detail, ...(level !== 'ok' && fix && { fix }) });
  const [major, minor] = process.versions.node.split('.').map(Number);
  add(major > 22 || (major === 22 && minor >= 13) ? 'ok' : 'fail', 'node', `v${process.versions.node}`, 'install Node 22.13 or later');
  const git = which('git');
  const repo = git && spawnSync(git, ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).status === 0;
  if (!git) add('warn', 'git', 'git is not on PATH: worktree sessions are not matched', 'install git');
  else add(repo ? 'ok' : 'warn', 'git', repo ? 'a git repo' : `${dir} is not in a git repo: worktree sessions are not matched`, `git -C ${dir} init`);

  let cfg;
  try { cfg = loadConfig(dir); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    // Every config error starts with the file it is in: the project config or the global $LFM_HOME/config.yaml.
    add('fail', 'config', e.message.split('\n')[0], e.message.startsWith('no ') ? 'learn-from-mistakes-axi init   # writes a working config' : `edit ${e.message.split(':')[0]}   # then run doctor again`);
    return checks;
  }
  add('ok', 'config', join(dir, PROJECT_FILE));
  if (!cfg.ignore) add('ok', 'state', `${cfg.state} (state_root, outside the project)`);
  else if (!existsSync(cfg.state)) add('ok', 'state', `${cfg.state}: the first run makes it with a * .gitignore`);
  else if (repo) {
    const ignored = spawnSync(git, ['-C', dir, 'check-ignore', '-q', join(cfg.state, 'lfm.sqlite')]).status === 0;
    add(ignored ? 'ok' : 'fail', 'state', ignored ? `${cfg.state} is git-ignored` : `${cfg.state} is not git-ignored, so run records could be committed`,
      'learn-from-mistakes-axi init   # writes .lfm/.gitignore');
  }

  // Each source: its own doctor hook, else a read; the item count is for this window.
  const w = parseInt(cfg.window, 10) * 86_400_000, since = Date.now() - w;
  if (!Object.keys(cfg.sources).length) add('warn', 'sources', 'none configured: a retro has nothing to read', 'learn-from-mistakes-axi init   # lists the sources it finds as gaps');
  for (const [id, s] of Object.entries(cfg.sources)) {
    const mod = SOURCES[s.type];
    let r;
    try {
      if (mod.doctor) r = await mod.doctor(id, s, { readFrom: since, causes: cfg.causes });
      else {
        const got = await mod.read(id, s, { causes: cfg.causes });
        const items = got.records ?? got.rows;
        r = { level: 'ok', detail: `${items.length} items, ${items.filter((x) => Date.parse(x.date || x.at) >= since).length} in the last ${cfg.window}` };
      }
    } catch (e) { if (!(e instanceof UsageError)) throw e; r = { level: 'fail', detail: e.message.replace(`source ${id}: `, ''), fix: e.next }; }
    add(r.level, `source ${id}`, `${s.type}: ${r.detail}`, r.fix);
  }

  // The agent CLIs found: a runner that is not offered, or whose --version fails, is a warning.
  const list = detect(cfg);
  for (const a of list.filter((x) => x.bin)) {
    add(a.problem ? 'warn' : 'ok', `agent ${a.runner}`, a.usable ? `${a.version}${a.problem ? `, ${a.problem}` : ''}` : a.problem,
      a.usable ? undefined : `set runner_path.${a.runner} in $LFM_HOME/config.yaml to a working ${binName(cfg, a.runner)}`);
  }
  const roles = resolveRoles(cfg, list);
  for (const name of ['worker', 'judge']) {
    const r = roles[name], key = r.runner.replace(/^acp:.*/, 'acp'), a = list.find((x) => x.runner === key), mod = RUNNERS[key];
    if (!r.bin) {
      add(a?.usable && mod?.unconfirmed ? 'warn' : 'fail', name, r.problem, list.some((x) => x.usable && !x.problem)
        ? `set ${name}.runner in ${PROJECT_FILE} to a usable agent CLI   # learn-from-mistakes-axi agents lists them`
        : `install ${INSTALL}, or set runner_path in $LFM_HOME/config.yaml`);
      continue;
    }
    add('ok', name, `${r.runner} ${a.version}, tools ${a.tools}`);
    // Login: the agent's own status command where it has one, else whether its login file or key variable exists.
    const probe = mod.loginStatus?.(r.model);
    if (probe) {
      const p = spawnSync(which(binName(cfg, key)), probe.args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
      const shown = `${r.runner} ${probe.args.join(' ')}`;
      if (p.error || p.signal) add('warn', `${name} login`, `${shown} did not finish (${p.error?.code ?? p.signal})`, probe.fix);
      else add(probe.ok(p) ? 'ok' : 'fail', `${name} login`, probe.ok(p) ? `${shown}: logged in` : `${shown}: not logged in${p.status ? ` (exit ${p.status})` : ''}`, probe.fix);
    } else add(a.login.startsWith('not found') ? 'warn' : 'ok', `${name} login`, a.login.startsWith('not found') ? `no ${r.runner} login file or key variable ${a.login.slice(10)}` : a.login);
    const fromEnv = name === 'worker' && (process.env.LFM_MODEL ?? '').trim();
    const cheap = MODELS[key]?.[0];
    if (!r.model) add('warn', `${name} model`, `none set, and ${r.runner} has no default in models.json: the agent CLI picks its own, which may be a premium model`, `set ${name}.model in ${PROJECT_FILE}`);
    else if (PREMIUM.test(r.model) && !cfg.allow_premium) {
      add('fail', `${name} model`, `${r.model}${fromEnv ? ' (LFM_MODEL)' : ''} is a premium model`,
        `${fromEnv ? 'unset LFM_MODEL, or ' : ''}set ${name}.model in ${PROJECT_FILE} to a cheap model${cheap ? ` such as ${cheap}` : ''}, or set allow_premium: true`);
    } else add('ok', `${name} model`, `${r.model}${fromEnv ? ' (LFM_MODEL)' : ''}${PREMIUM.test(r.model) ? ' (allow_premium)' : ''}`);
  }
  // The identity rule: the judge never checks its own work.
  if (roles.worker.bin && roles.judge.bin) {
    const clash = same(roles.worker, roles.judge);
    const id = (r) => `${r.runner}${r.model ? ` ${r.model}` : ''}`;
    add(clash ? 'fail' : 'ok', 'identity', clash ? `the worker and the judge are both ${id(roles.worker)}, so the judge would judge its own work`
      : `worker ${id(roles.worker)}, judge ${id(roles.judge)}`, `set judge.runner and judge.model in ${PROJECT_FILE} to another agent CLI or a different model, or install a second agent CLI`);
  }

  // The skill in each usable agent CLI's own skills dir, or in the project.
  for (const a of list.filter((x) => x.usable && RUNNERS[x.runner].skills)) {
    const home = join(RUNNERS[a.runner].skills(process.env), 'learn-from-mistakes');
    const at = [home, join(dir, '.claude', 'skills', 'learn-from-mistakes'), join(dir, '.agents', 'skills', 'learn-from-mistakes')].find((d) => existsSync(join(d, 'SKILL.md')));
    add(at ? 'ok' : 'warn', `skill ${a.runner}`, at ? join(at, 'SKILL.md') : `not installed in ${home}`, `mkdir -p ${home} && cp ${SKILL} ${home}/`);
  }
  const signoff = cfg.signoff !== 'off' && which('sign-off');
  add(cfg.signoff === 'off' || signoff ? 'ok' : 'warn', 'sign-off', cfg.signoff === 'off' ? 'off: questions go in report.txt'
    : signoff || 'sign-off is not on PATH: questions go in report.txt (plain-text fallback)');

  // --live: one call per role that asks the agent to write a file; it must answer and write nothing.
  if (opts.live) for (const name of ['worker', 'judge']) {
    const r = roles[name];
    if (!r.bin) continue;
    try {
      const { test } = await agents(cfg, { test: r.runner, model: r.model });
      add('ok', `${name} live`, `${r.runner} answered and wrote no file: ${JSON.stringify(test.reply.slice(0, 80))}`);
    } catch (e) { if (!(e instanceof UsageError)) throw e; add('fail', `${name} live`, e.message, e.next); }
  }
  return checks;
}
