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
 */

export interface ClaudeConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** What the MCP client actually needs. `pick` names a connection only when this machine has several. */
export function mcpConfig(pick: string | null): ClaudeConfig {
  return {
    command: 'npx',
    args: ['-y', 'tinhead-mcp'],
    ...(pick ? { env: { TINHEAD_GRANT: pick } } : {}),
  };
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
  pick: string | null,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    const json = JSON.stringify(mcpConfig(pick)).replace(/"/g, '\\"');
    return `claude mcp add-json tinhead '${json}'`;
  }
  // `-e`, and no `--transport`: stdio is the default, and this is the CLI's own
  // documented shape rather than a variation on it.
  const env = pick ? `-e TINHEAD_GRANT=${pick} ` : '';
  return `claude mcp add ${env}tinhead -- npx -y tinhead-mcp`;
}

/** The block for clients with no CLI of their own. Always the same shape. */
export function configBlock(pick: string | null): string {
  return JSON.stringify({ mcpServers: { tinhead: mcpConfig(pick) } }, null, 2);
}
