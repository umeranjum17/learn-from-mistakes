// doctor: one check per line, ok, warn or fail, and the fix for each one that is not ok. Its checks only read; --live is
// the exception: one agent call per role (it costs tokens) that writes its run dir under the state dir. Login checks read
// a status and never print it, so no credential text reaches the output; they never refresh a token.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shq, UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import * as byokit from './runners/byokit.mjs';
import { globalFile, loadConfig, PROJECT_FILE, SOURCES } from './config.mjs';
import { agents, binName, detect, fileOf, KEY, PREMIUM, premiumBlocked, resolveRoles, RUNNERS, same, which } from './runners/index.mjs';
import { saveCommand } from './ask.mjs';
const SKILL = fileURLToPath(new URL('../skills/learn-from-mistakes/SKILL.md', import.meta.url));

export async function doctor(dir, opts) {
  const checks = [];
  const add = (level, label, detail, fix) => checks.push({ level, label, detail, ...(level !== 'ok' && fix && { fix }) });
  const file = shq(join(dir, PROJECT_FILE));
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
    const from = [join(dir, PROJECT_FILE), globalFile()].find((f) => e.message.startsWith(f));
    add('fail', 'config', e.message.split('\n')[0], e.message.startsWith('no ') ? `learn-from-mistakes-axi init --dir ${shq(dir)}   # writes a working config` : `edit ${shq(from)}   # then run doctor again`);
    return checks;
  }
  add('ok', 'config', join(dir, PROJECT_FILE));
  if (!cfg.ignore) add('ok', 'state', `${cfg.state} (state_root, outside the project)`);
  else if (!existsSync(cfg.state)) add('ok', 'state', `${cfg.state}: the first run makes it with a * .gitignore`);
  else if (repo) {
    const ignored = spawnSync(git, ['-C', dir, 'check-ignore', '-q', join(cfg.state, 'lfm.sqlite')]).status === 0;
    add(ignored ? 'ok' : 'fail', 'state', ignored ? `${cfg.state} is git-ignored` : `${cfg.state} is not git-ignored, so run records could be committed`,
      `echo '*' >> ${shq(join(cfg.state, '.gitignore'))}`);
  }

  // Each source's own doctor hook: readable, its count in the window, and the entries it skipped.
  const since = Date.now() - parseInt(cfg.window, 10) * 86_400_000;
  if (!Object.keys(cfg.sources).length) add('warn', 'sources', 'none configured: a retro has nothing to read', `learn-from-mistakes-axi init --dir ${shq(dir)}   # lists the sources it finds as gaps`);
  for (const [id, s] of Object.entries(cfg.sources)) {
    let r;
    try { r = await SOURCES[s.type].doctor(id, s, { readFrom: since, causes: cfg.causes, project: join(dir, PROJECT_FILE) }); }
    catch (e) { if (!(e instanceof UsageError)) throw e; r = { level: 'fail', detail: e.message.replace(`source ${id}: `, ''), fix: e.next }; }
    add(r.level, `source ${id}`, `${s.type}: ${r.detail}`, r.fix);
  }

  const list = detect(cfg);
  const roles = await resolveRoles(cfg, list);
  const failedModel = new Set(); // a role whose model check failed gets no --live call
  for (const name of ['worker', 'judge']) {
    const r = roles[name], key = r.runner.replace(/^acp:.*/, 'acp'), a = list.find((x) => x.runner === key), mod = RUNNERS[key];
    const at = fileOf(cfg, KEY[name]);
    if (r.fix) { add('fail', name, r.problem, r.fix); continue; } // a BYOKit route that failed its own check
    if (!r.runner) { add('fail', name, r.problem, saveCommand([KEY[name]], opts.dir)); continue; } // not set: the user chooses
    if (!r.bin) { // only the configured agent is checked: the tool never offers another one
      add('fail', name, r.problem, a && !a.usable ? `install ${binName(cfg, key)}, or set ${key === 'acp' ? 'acpx_path' : `agent_path_override.${key}`} in ${shq(cfg.globalPath)}`
        : `set ${KEY[name]} in ${at} to another agent the user chooses`);
      continue;
    }
    const route = byokit.routeOf(r.runner);
    if (route) { // BYOKit's own checks for its sign-in or plan key, with no paid call
      add('ok', name, `${r.runner}, a BYOKit route`);
      for (const c of await byokit.doctor(route)) add(c.status, `${name} login`, c.detail, c.fix);
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
    const { model } = r;
    const setModel = `set agent_config."${r.runner}".model in ${fileOf(cfg, `agent_config.${r.runner}`)}`;
    if (!model && route) { failedModel.add(name); add('fail', `${name} model`, `none set for ${r.runner}: a BYOKit route needs one`, setModel); }
    else if (!model && cfg.allow_premium) add('warn', `${name} model`, `none set for ${r.runner}: the agent CLI picks its own (allow_premium)`, setModel);
    else if (!model) { failedModel.add(name); add('fail', `${name} model`, `none set for ${r.runner}: the agent CLI would pick its own, which may be a premium model`, `${setModel}, or set allow_premium: true in ${fileOf(cfg, 'allow_premium')}`); }
    else if (premiumBlocked(cfg, model)) {
      failedModel.add(name);
      add('fail', `${name} model`, `${model} is a premium model`, `${setModel} to a cheap model, or set allow_premium: true in ${fileOf(cfg, 'allow_premium')}`);
    } else add('ok', `${name} model`, `${model}${PREMIUM.test(model) ? ' (allow_premium)' : ''}`);
  }
  // The identity rule: the judge never checks its own work.
  const checked = (r) => r.bin && !r.fix;
  if (checked(roles.worker) && checked(roles.judge)) {
    const clash = same(roles.worker, roles.judge);
    const id = (r) => `${r.runner}${r.model ? ` ${r.model}` : ''}`;
    add(clash ? 'fail' : 'ok', 'identity', clash ? `the worker (${id(roles.worker)}) and the judge (${id(roles.judge)}) resolve to the same agent and model, so the judge would judge its own work`
      : `worker ${id(roles.worker)}, judge ${id(roles.judge)}`, `set judge_agent in ${fileOf(cfg, 'judge_agent')} to another agent the user chooses`);
  }

  // The skill in each configured, usable agent CLI's own skills dir, or in the project.
  const used = new Set([roles.worker.runner, roles.judge.runner]);
  for (const a of list.filter((x) => used.has(x.runner) && x.usable && RUNNERS[x.runner].skills)) {
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
    if (!r.bin || r.problem || failedModel.has(name)) continue; // its fail line above already names the fix
    try {
      const { test } = await agents(cfg, { test: r.runner, model: r.model });
      add('ok', `${name} live`, `${r.runner} answered and wrote no file: ${JSON.stringify(test.reply.slice(0, 80))}`);
    } catch (e) { if (!(e instanceof UsageError)) throw e; add('fail', `${name} live`, e.message, e.next); }
  }
  return checks;
}
