// Any ACP agent through acpx: `acp:<target>` names the acpx agent. acpx denies every permission request and asks for
// no tools, but an agent that runs its tools without asking still writes (pi and opencode both did), so it is not
// offered. If a later version offers it, the identity rule must resolve acp:<target> to the target's own command.
export const bin = 'acpx';
export const tools = 'off';
export const unconfirmed = 'not offered: acpx --deny-all only denies the permission requests an agent sends, and agents that run tools without asking still write (agents --test acp:<target> checks one)';
export const login = () => ({ files: [], vars: [] });
export const command = ({ model, dir, target, extra }) => ({
  args: ['--cwd', dir, '--format', 'json', '--json-strict', '--deny-all', '--allowed-tools', '', '--non-interactive-permissions', 'deny',
    ...(model ? ['--model', model] : []), ...extra, target, 'exec', '--file', '-'],
  stdin: true,
});
// JSON-RPC lines; the answer is the agent's message chunks, an error response carries its cause.
export function answer(out) {
  let text = '', error;
  for (const line of out.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const u = e?.params?.update;
    if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text;
    if (e?.error) error ??= e.error.message || `error ${e.error.code}`;
  }
  return error ? { error } : { text };
}
