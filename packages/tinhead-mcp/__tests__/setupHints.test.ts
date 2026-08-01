import { claudeAddCommand, configBlock, mcpConfig } from '../src/setupHints';

/**
 * The last instruction a person reads before `tinhead-mcp` works or does not.
 *
 * **This exists because the Windows form was broken for every user and nothing
 * caught it.** The command printed was the one the Claude Code docs give:
 *
 *     claude mcp add -e KEY=v tinhead -- npx -y tinhead-mcp
 *
 * On Windows `claude` is an npm-generated PowerShell shim, and the `--` that
 * stops option parsing is lost before node sees it — so the command dies with
 * `error: unknown option '-y'`. It fails for the documented example too, so no
 * arrangement of `mcp add` survives; `add-json` takes one argument and needs no
 * separator. PowerShell then strips bare double quotes out of a native command's
 * arguments, so the JSON has to arrive backslash-escaped.
 *
 * Both branches are pinned here, on whatever machine runs the suite, because a
 * platform-specific string is exactly the kind that is only ever checked on the
 * platform its author happens to use.
 */

const PICK = '3dcdb624-a8fa-4cf6-b003-292763681ada';

describe('the Windows command, which is the one that was wrong', () => {
  const cmd = claudeAddCommand(PICK, 'win32');

  it('uses add-json and carries NO `--` separator', () => {
    expect(cmd).toContain('claude mcp add-json tinhead');
    // The whole point: `--` never survives the PowerShell shim.
    expect(cmd).not.toMatch(/\s--\s/);
    expect(cmd).not.toContain('mcp add -e');
  });

  it('escapes its quotes, and unescapes back to the exact config', () => {
    // PowerShell strips bare double quotes, so an unescaped blob arrives as
    // `{command:npx}` and npm's CLI refuses it as invalid input.
    expect(cmd).toContain('\\"command\\"');
    expect(cmd).not.toContain('{"command"');

    const json = cmd.slice(cmd.indexOf("'") + 1, cmd.lastIndexOf("'"));
    expect(JSON.parse(json.replace(/\\"/g, '"'))).toEqual({
      command: 'npx',
      args: ['-y', 'tinhead-mcp'],
      env: { TINHEAD_GRANT: PICK },
    });
  });

  it('omits the env entirely when this machine holds one connection', () => {
    const solo = claudeAddCommand(null, 'win32');
    expect(solo).not.toContain('TINHEAD_GRANT');
    const json = solo.slice(solo.indexOf("'") + 1, solo.lastIndexOf("'"));
    expect(JSON.parse(json.replace(/\\"/g, '"')).env).toBeUndefined();
  });
});

describe('the POSIX command', () => {
  it('is the CLI’s own documented shape: `-e`, no --transport, and a `--`', () => {
    const cmd = claudeAddCommand(PICK, 'darwin');
    expect(cmd).toBe(`claude mcp add -e TINHEAD_GRANT=${PICK} tinhead -- npx -y tinhead-mcp`);
    // stdio is the default; naming it was a variation on the documented form.
    expect(cmd).not.toContain('--transport');
  });

  it('drops the -e when there is nothing to disambiguate', () => {
    expect(claudeAddCommand(null, 'linux')).toBe('claude mcp add tinhead -- npx -y tinhead-mcp');
  });
});

describe('the config block, for clients with no CLI', () => {
  it('is valid JSON naming one stdio server', () => {
    const parsed = JSON.parse(configBlock(PICK)) as {
      mcpServers: { tinhead: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(parsed.mcpServers.tinhead.command).toBe('npx');
    expect(parsed.mcpServers.tinhead.args).toEqual(['-y', 'tinhead-mcp']);
    expect(parsed.mcpServers.tinhead.env.TINHEAD_GRANT).toBe(PICK);
  });

  it('carries no secret — the token is in the OS store, the address in connections.json', () => {
    const block = configBlock(PICK);
    expect(block).not.toContain('tinhead1:');
    expect(block).not.toContain('TINHEAD_URL');
    // A connection id is explicitly not a secret (SPEC-AGENT §4.5); anything
    // long and opaque BESIDES that would be.
    expect(block.replace(PICK, '')).not.toMatch(/[A-Za-z0-9_-]{30,}/);
  });

  it('describes the same server both ways', () => {
    expect(JSON.parse(configBlock(PICK)).mcpServers.tinhead).toEqual(mcpConfig(PICK));
  });
});
