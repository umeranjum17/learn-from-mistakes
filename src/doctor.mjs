// doctor: one check per line, ok, warn or fail, and the fix for each one that is not ok. Its checks only read; --live is
// the exception: one agent call per role (it costs tokens) that writes its run dir under the state dir. Login checks read
// a status and never print it, so no credential text reaches the output; they never refresh a token.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shq, UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import * as byokit from './runners/byokit.mjs';
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
  else add(repo ? 'ok' : 'warn', 'git', repo ? 'a git repo' : `${dir} is not in a git repo: worktree sessions are not matched`, `git -C ${shq(dir)} init`);

  let cfg;
  try { cfg = loadConfig(dir); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    // Every config error starts with the file it is in: the project config or the global $LFM_HOME/config.yaml.
    add('fail', 'config', e.message.split('\n')[0], e.message.startsWith('no ') ? `learn-from-mistakes-axi init --dir ${shq(dir)}   # writes a working config` : `edit ${shq(e.message.split(':')[0])}   # then run doctor again`);
    return checks;
  }
  add('ok', 'config', join(dir, PROJECT_FILE));
  if (!cfg.ignore) add('ok', 'state', `${cfg.state} (state_root, outside the project)`);
  else if (!existsSync(cfg.state)) add('ok', 'state', `${cfg.state}: the first run makes it with a * .gitignore`);
  else if (repo) {
    const ignored = spawnSync(git, ['-C', dir, 'check-ignore', '-q', join(cfg.state, 'lfm.sqlite')]).status === 0;
    add(ignored ? 'ok' : 'fail', 'state', ignored ? `${cfg.state} is git-ignored` : `${cfg.state} is not git-ignored, so run records could be committed`,
      `learn-from-mistakes-axi init --dir ${shq(dir)}   # writes .lfm/.gitignore`);
  }

  // Each source's own doctor hook: readable, its count in the window, and the entries it skipped.
  const since = Date.now() - parseInt(cfg.window, 10) * 86_400_000;
  if (!Object.keys(cfg.sources).length) add('warn', 'sources', 'none configured: a retro has nothing to read', `learn-from-mistakes-axi init --dir ${shq(dir)}   # lists the sources it finds as gaps`);
  for (const [id, s] of Object.entries(cfg.sources)) {
    let r;
    try { r = await SOURCES[s.type].doctor(id, s, { readFrom: since, causes: cfg.causes }); }
    catch (e) { if (!(e instanceof UsageError)) throw e; r = { level: 'fail', detail: e.message.replace(`source ${id}: `, ''), fix: e.next }; }
    add(r.level, `source ${id}`, `${s.type}: ${r.detail}`, r.fix);
  }

  const list = detect(cfg);
  const roles = await resolveRoles(cfg, list);
  for (const name of ['worker', 'judge']) {
    const r = roles[name], key = r.runner.replace(/^acp:.*/, 'acp'), a = list.find((x) => x.runner === key), mod = RUNNERS[key];
    if (!r.bin) {
      const offered = list.filter((x) => x.usable && !x.problem).map((x) => x.runner);
      add('fail', name, r.problem, offered.length
        ? `set ${name}.runner in ${PROJECT_FILE} to ${offered.join(' or ')}`
        : `install ${INSTALL}, or set runner_path in $LFM_HOME/config.yaml`);
      continue;
    }
    const route = byokit.routeOf(r.runner);
    if (route) { // BYOKit's own checks for its sign-in or plan key, with no paid call; its node row is the node check above
      add('ok', name, `${r.runner}, a BYOKit route`);
      for (const c of await byokit.doctor(route)) if (c.label !== 'node') add(c.status, `${name} login`, c.detail, c.fix);
    } else {
      add('ok', name, `${r.runner} ${a.version}, tools ${a.tools}`);
      // Login: the agent's own status command where it has one, else whether its login file or key variable exists.
      const probe = mod.loginStatus?.(r.model);
      if (probe) {
        const p = spawnSync(which(binName(cfg, key)), probe.args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
        const shown = `${r.runner} ${probe.args.join(' ')}`;
        if (probe.ok(p)) add('ok', `${name} login`, `${shown}: logged in`);
        else if (probe.file) {
          // The probe failed for any reason: the login file decides, checked for existence only.
          const why = p.error?.code ?? p.signal ?? `exit ${p.status}`;
          if (existsSync(probe.file)) add('warn', `${name} login`, `pi auth check failed (${why}); auth.json present`);
          else add('fail', `${name} login`, `pi auth check failed (${why}); no auth.json`, probe.fix);
        } else if (p.error || p.signal) add('warn', `${name} login`, `${shown} did not finish (${p.error?.code ?? p.signal})`, probe.fix);
        else add('fail', `${name} login`, `${shown}: not logged in${p.status ? ` (exit ${p.status})` : ''}`, probe.fix);
      } else add(a.login.startsWith('not found') ? 'warn' : 'ok', `${name} login`, a.login.startsWith('not found') ? `no ${r.runner} login file or key variable ${a.login.slice(10)}` : a.login);
    }
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
    add(at ? 'ok' : 'warn', `skill ${a.runner}`, at ? join(at, 'SKILL.md') : `not installed in ${home}`, `mkdir -p ${shq(home)} && cp ${shq(SKILL)} ${shq(`${home}/`)}`);
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
