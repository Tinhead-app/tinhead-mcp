/**
 * `tinhead-mcp` — the two things `login` prints once it has stored the code.
 *
 * Pure string builders, in their own file with NO imports, for one reason: they
 * are the last instruction a person reads before the thing either works or does
 * not, and they were wrong on Windows for every user until someone tried it.
 * Here they can be unit-tested; inside `cli.ts` they could not, because that
 * module pulls in the MCP SDK through `server.ts`.
 *
 * `platform` is a parameter rather than a read of `process.platform` so both
 * branches are checkable on one machine.
 *
 * **What a config carries is a LABEL, and never a connection id.** This file
 * used to emit `TINHEAD_GRANT: <uuid>` whenever the machine held more than one
 * connection — correct at that instant and perishable ever after. A grant id
 * dies on every revoke, reissue and `forget`, and the config naming it is a file
 * this tool cannot reach; the door then refused to start and the failure was
 * invisible inside a client, which is a support ticket that begins "it just
 * stopped working". A label is chosen by the person, means whatever they point
 * it at, and survives the connection being replaced underneath it.
 *
 * **Every config gets one, including the first.** The old single-connection form
 * carried no argument at all and resolved by "there is only one" — so registering
 * a SECOND connection silently broke the first one's config. Naming from the
 * start is what makes that unreachable.
 */

/** The label `login` gives the first connection when the person just presses enter. */
export const DEFAULT_LABEL = 'default';

/**
 * What a label may be. Lowercase, short, and dull on purpose.
 *
 * The cap is load-bearing rather than cosmetic: a setup code is 43 characters of
 * base64url, so a 32-character lowercase limit means a pasted CODE cannot be
 * accepted as a label and land in a config file in the clear. Uppercase being
 * absent refuses it a second time. This is the same class `storeKey` closes for
 * filenames — a caller who is confused about which string is which must not be
 * able to write the perishable one somewhere permanent.
 */
export const LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isValidLabel(label: string): boolean {
  return LABEL_RE.test(label);
}

/**
 * What the server is called in the client's own config.
 *
 * The default connection keeps the bare name, so the ordinary first run still
 * produces `mcp__tinhead__*` tools and reads the way the docs do. A named one is
 * suffixed, because two connections registered under one server name would
 * collide in every client and the second `add` would overwrite the first.
 */
export function serverName(label: string): string {
  return label === DEFAULT_LABEL ? 'tinhead' : `tinhead-${label}`;
}

export interface ClaudeConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * What the MCP client actually needs.
 *
 * No `env` key, ever. The token is in the OS store, the address is in
 * `connections.json`, and which connection this is comes from the label in
 * argv — so there is nothing left for an environment to carry, and no snapshot
 * of today's state to go stale.
 */
export function mcpConfig(label: string): ClaudeConfig {
  return { command: 'npx', args: ['-y', 'tinhead-mcp', '--as', label] };
}

/**
 * The one command that registers the server with Claude Code.
 *
 * **Windows gets a different one, because the documented command cannot work
 * there.** `claude` on Windows is an npm-generated PowerShell shim
 * (`claude.ps1`), and the `--` that stops option parsing is lost before node
 * sees it — so `-- npx -y tinhead-mcp` returns `error: unknown option '-y'`.
 * That happens to the CLI's own documented example too, so there is no
 * arrangement of `mcp add` that survives it.
 *
 * `add-json` takes the whole config as ONE argument and needs no `--`. The
 * backslashes are for PowerShell, which strips bare double quotes out of a
 * native command's arguments — an unescaped blob arrives as `{command:npx}` and
 * is refused as invalid input.
 */
export function claudeAddCommand(
  label: string,
  platform: NodeJS.Platform = process.platform
): string {
  const name = serverName(label);
  if (platform === 'win32') {
    const json = JSON.stringify(mcpConfig(label)).replace(/"/g, '\\"');
    return `claude mcp add-json ${name} '${json}'`;
  }
  // No `--transport`: stdio is the default, and this is the CLI's own documented
  // shape rather than a variation on it. `--as` rides after the command, where
  // npx passes it through to the binary.
  return `claude mcp add ${name} -- npx -y tinhead-mcp --as ${label}`;
}

/** The block for clients with no CLI of their own. Always the same shape. */
export function configBlock(label: string): string {
  return JSON.stringify({ mcpServers: { [serverName(label)]: mcpConfig(label) } }, null, 2);
}
