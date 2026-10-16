// BYOKit: a plain model call in this process, with no agent CLI and no tools. The optional packages load only for this
// runner. Two kinds of plan route:
// - a sign-in plan (chatgpt, claude): the person's sign-in, read from the machine's BYOKit store (the one every BYOKit
//   app shares under the seal service "byokit");
// - a plan key route in BYOKit's route list, such as opencode-go: the key comes from the variable BYOKit's route names
//   (OPENCODE_API_KEY), held in memory for the one call and never saved; pi-ai's model list gives the model.
import { randomUUID } from 'node:crypto';

export const tools = 'none';
export const INSTALL = 'npm install -g learn-from-mistakes-axi   # with its optional dependencies (not --omit=optional): the BYOKit packages install beside it';
// The two sign-in plans BYOKit's respond() answers in one plain call (BYOKit's API); every other route comes from routes().
export const ROUTES = ['chatgpt', 'claude'];
const MEMBER = 'lfm';
const NODE = '22.18';

// The route a runner names as byokit:<route>, or undefined.
export const routeOf = (runner) => runner.match(/^byokit:(.+)/)?.[1];

// The routes a person can name: the sign-in plans, then BYOKit's plan key aliases whose readiness is ready.
// Never throws: with BYOKit not installed nothing is known, so no route is offered.
export async function readyRoutes() {
  try {
    const keys = (await import('@byokit/accounts')).routes().filter((r) => r.via === 'plan_key' && r.readiness === 'ready').flatMap((r) => r.aliases ?? []);
    return [...new Set([...ROUTES, ...keys])];
  } catch { return []; }
}

// The models BYOKit exposes for a route, or undefined when it exposes none: a sign-in plan's catalogue models, else a
// plan key route's pi-ai builtin models. Never throws; the caller leaves its model question as is without a list.
export async function routeModels(route) {
  try {
    if (ROUTES.includes(route)) {
      const ids = Object.values((await import('@byokit/accounts')).provider(route)?.models ?? {}).filter((m) => typeof m === 'string');
      return ids.length ? [...new Set(ids)] : undefined;
    }
    const key = await planKey(route);
    if (!key) return undefined;
    const ids = (await import('@earendil-works/pi-ai/providers/all')).getBuiltinModels(key.upstream.id).map((m) => m.id).filter(Boolean);
    return ids.length ? ids : undefined;
  } catch { return undefined; }
}

// BYOKit's row for a plan key route, or undefined for a sign-in plan or an unknown name.
async function planKey(route) {
  if (!ROUTES.includes(route)) return (await import('@byokit/accounts')).routes().find((r) => r.via === 'plan_key' && r.aliases?.includes(route));
}

export async function signIn(route) {
  const key = await planKey(route).catch(() => undefined);
  const then = `then: learn-from-mistakes-axi agents --test byokit:${route}`;
  return key ? `set ${key.upstream.method} to your ${key.name} key, ${then}`
    : `sign in to ${route} through BYOKit for member "${MEMBER}" (machine store, seal service "byokit"), ${then}`;
}

// What stops this runner before any call, with its fix: the Node version or the missing packages.
export function problem() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) return { problem: `BYOKit needs Node ${NODE} or later; this is ${process.version}`, fix: `install Node ${NODE} or later` };
  try { for (const p of ['@byokit/accounts', '@byokit/secrets', '@earendil-works/pi-ai']) import.meta.resolve(p); } catch { return { problem: 'BYOKit is not installed', fix: INSTALL }; }
}

// problem(), then a route that is not a BYOKit plan route.
export async function check(route) {
  const p = problem();
  if (p) return p;
  if (ROUTES.includes(route) || await planKey(route)) return;
  return { problem: `byokit:${route} is not a BYOKit plan route`, fix: `use one of: ${(await readyRoutes()).map((r) => `byokit:${r}`).join(', ')}` };
}

async function open() {
  const [{ Accounts, machineStore }, { osKeyringSeal }] = await Promise.all([import('@byokit/accounts'), import('@byokit/secrets')]);
  const seal = osKeyringSeal({ service: 'byokit' });
  const base = process.env.LFM_TEST_BYOKIT_BASE; // tests only: where BYOKit's stand-in OpenAI answers
  return new Accounts({ store: (m) => machineStore(m, seal), ...(base && { apiBase: base }) });
}

// A plan key call: the key and BYOKit's account index stay in memory, so nothing reaches the BYOKit store.
async function askKey(key, { model, prompt, signal }) {
  const secret = process.env[key.upstream.method];
  if (!secret) return { error: `${key.upstream.method} is not set` };
  const [{ Accounts, memoryStore }, { overrideStore }, { getBuiltinModel }] = await Promise.all([
    import('@byokit/accounts'), import('@byokit/secrets'), import('@earendil-works/pi-ai/providers/all')]);
  const found = getBuiltinModel(key.upstream.id, model);
  if (!found) return { error: `pi-ai lists no model ${model} for ${key.upstream.id}` };
  const base = process.env.LFM_TEST_BYOKIT_BASE; // tests only: a stand-in for the provider
  const account = `${key.id}.${MEMBER}`, index = memoryStore();
  const accounts = new Accounts({ store: () => index, keyStore: () => overrideStore({ [`accounts.${account}`]: secret }) });
  try {
    // ponytail: BYOKit's key call drops pi-ai's OpenCode session header, which OpenCode Go needs, so the host sends it;
    // remove when BYOKit keeps the provider's own streams.
    const headers = key.provider === 'opencode' ? { 'x-opencode-session': randomUUID() } : {};
    const msg = await accounts.respondKey(MEMBER, { account, model: { ...found, ...(base && { baseUrl: base }) },
      context: { messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] }, options: { signal, headers } });
    const u = msg.usage;
    return { text: msg.content.filter((c) => c.type === 'text').map((c) => c.text).join(''),
      ...(u && { tokens_in: u.input + u.cacheRead + u.cacheWrite, tokens_out: u.output }) };
  } finally {
    accounts.stop();
  }
}

// One call. The answer is { text } (with tokens_in and tokens_out when the provider reports them), or { error } with `transient` for a busy provider or a dropped network; the
// caller retries those. A call past `timeoutMs` is aborted.
export async function ask({ route, model, prompt, timeoutMs }) {
  const signal = AbortSignal.timeout(timeoutMs);
  let accounts;
  try {
    const key = await planKey(route);
    if (key) return await askKey(key, { model, prompt, signal });
    accounts = await open();
    // The request shape per sign-in plan is BYOKit's own API (Ask vs ClaudePlanAsk).
    const text = route === 'claude'
      ? await accounts.respond(MEMBER, { provider: 'claude', model, max_tokens: 8192, messages: [{ role: 'user', content: prompt }], signal })
      : await accounts.respond(MEMBER, { instructions: 'Follow the instructions in the message.', input: prompt, model, signal });
    return { text };
  } catch (e) {
    if (signal.aborted) return { timedOut: true };
    return { error: e.message, transient: ['overloaded', 'network'].includes(e.kind) };
  } finally {
    accounts?.stop();
  }
}

// doctor's checks for one route, with no paid call: the route, then the sign-in's state or the key.
export async function doctor(route) {
  const label = `byokit:${route}`;
  let accounts;
  try {
    const p = await check(route);
    if (p) return [{ status: 'fail', label, detail: p.problem, fix: p.fix }];
    const key = await planKey(route);
    if (key) {
      const set = Boolean(process.env[key.upstream.method]);
      return [{ status: set ? 'ok' : 'fail', label, detail: `${key.upstream.method} is ${set ? '' : 'not '}set`, ...(!set && { fix: await signIn(route) }) }];
    }
    accounts = await open();
    const s = await accounts.status(MEMBER, route);
    const state = { ready: 'ok', resting: 'warn' }[s.state] ?? 'fail'; // resting: signed in, at a limit for now
    return [{ status: state, label, detail: s.words, ...(state === 'fail' && { fix: await signIn(route) }) }];
  } catch (e) { // the store or its seal cannot be read, such as a locked keyring
    return [{ status: 'fail', label, detail: e.message, fix: await signIn(route) }];
  } finally {
    accounts?.stop();
  }
}
