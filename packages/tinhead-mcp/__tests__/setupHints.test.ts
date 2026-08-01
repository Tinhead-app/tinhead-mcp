import {
  DEFAULT_LABEL,
  claudeAddCommand,
  configBlock,
  isValidLabel,
  mcpConfig,
  serverName,
} from '../src/setupHints';

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
 *
 * **And it exists a second time because what the command CARRIED was perishable.**
 * A config naming `TINHEAD_GRANT: <uuid>` was correct the day it was printed and
 * dead after the next revoke, reissue or `forget` — at which point the door
 * refused to start and an MCP client showed nothing at all. The tests below pin
 * the absence of that key as hard as they pin the Windows shape.
 */

const LABEL = 'work';

describe('the Windows command, which is the one that was wrong', () => {
  const cmd = claudeAddCommand(LABEL, 'win32');

  it('uses add-json and carries NO `--` separator', () => {
    expect(cmd).toContain('claude mcp add-json tinhead-work');
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
      args: ['-y', 'tinhead-mcp', '--as', LABEL],
    });
  });

  it('names the default connection too — every config carries a label', () => {
    // The old form emitted no argument for a lone connection and resolved by
    // "there is only one", so registering a SECOND connection silently broke the
    // first one's config. Naming from the first run is what closes that.
    const solo = claudeAddCommand(DEFAULT_LABEL, 'win32');
    const json = solo.slice(solo.indexOf("'") + 1, solo.lastIndexOf("'"));
    expect(JSON.parse(json.replace(/\\"/g, '"')).args).toEqual([
      '-y',
      'tinhead-mcp',
      '--as',
      'default',
    ]);
  });
});

describe('the POSIX command', () => {
  it('is the CLI’s own documented shape: no --transport, and a `--`', () => {
    expect(claudeAddCommand(LABEL, 'darwin')).toBe(
      'claude mcp add tinhead-work -- npx -y tinhead-mcp --as work'
    );
    // stdio is the default; naming it was a variation on the documented form.
    expect(claudeAddCommand(LABEL, 'darwin')).not.toContain('--transport');
  });

  it('keeps the bare server name for the default connection', () => {
    expect(claudeAddCommand(DEFAULT_LABEL, 'linux')).toBe(
      'claude mcp add tinhead -- npx -y tinhead-mcp --as default'
    );
  });
});

describe('no config carries a connection id, on any platform', () => {
  // The regression this whole design replaced. A grant id in a config file is a
  // snapshot of state that legitimately changes, in a file this tool can never
  // reach again.
  for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
    it(`omits TINHEAD_GRANT and env entirely on ${platform}`, () => {
      const cmd = claudeAddCommand(LABEL, platform);
      expect(cmd).not.toContain('TINHEAD_GRANT');
      expect(cmd).not.toContain('TINHEAD_URL');
      expect(cmd).not.toContain('env');
    });
  }

  it('has no env key in the config object at all', () => {
    expect(mcpConfig(LABEL).env).toBeUndefined();
    expect(Object.keys(mcpConfig(LABEL))).toEqual(['command', 'args']);
  });

  it('has no uuid anywhere in either form', () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(claudeAddCommand(LABEL, 'win32')).not.toMatch(uuid);
    expect(configBlock(LABEL)).not.toMatch(uuid);
  });
});

describe('the label, which is the thing a config may safely carry', () => {
  it('accepts short lowercase handles', () => {
    for (const ok of ['default', 'work', 'a', 'my-tree', 'x_1', '9lives']) {
      expect(isValidLabel(ok)).toBe(true);
    }
  });

  it('REFUSES a setup code, which is the mistake that must not reach a config', () => {
    // 32 bytes of base64url is exactly 43 characters. Two independent reasons it
    // cannot pass: the 32-character cap, and lowercase-only.
    const code = 'A'.repeat(21) + 'b'.repeat(22);
    expect(code).toHaveLength(43);
    expect(isValidLabel(code)).toBe(false);
    // ...and a lowercased one of legal length still fails on the cap alone.
    expect(isValidLabel('a'.repeat(43))).toBe(false);
    expect(isValidLabel('a'.repeat(33))).toBe(false);
    expect(isValidLabel('a'.repeat(32))).toBe(true);
  });

  it('refuses uppercase, spaces, dots, slashes and the empty string', () => {
    for (const bad of ['Work', 'my tree', 'a.b', 'a/b', '..', '', '-lead', 'tinhead1:xyz']) {
      expect(isValidLabel(bad)).toBe(false);
    }
  });

  it('refuses a uuid, so a connection id cannot be smuggled in as a name', () => {
    expect(isValidLabel('3dcdb624-a8fa-4cf6-b003-292763681ada')).toBe(false);
  });
});

describe('the server name', () => {
  it('is bare for the default and suffixed otherwise, so two never collide', () => {
    expect(serverName(DEFAULT_LABEL)).toBe('tinhead');
    expect(serverName('work')).toBe('tinhead-work');
    expect(serverName('work')).not.toBe(serverName('personal'));
  });
});

describe('the config block, for clients with no CLI', () => {
  it('is valid JSON naming one stdio server, under the derived name', () => {
    const parsed = JSON.parse(configBlock(LABEL)) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(Object.keys(parsed.mcpServers)).toEqual(['tinhead-work']);
    expect(parsed.mcpServers['tinhead-work'].command).toBe('npx');
    expect(parsed.mcpServers['tinhead-work'].args).toEqual(['-y', 'tinhead-mcp', '--as', 'work']);
  });

  it('carries no secret — the token is in the OS store, the address in connections.json', () => {
    const block = configBlock(LABEL);
    expect(block).not.toContain('tinhead1:');
    expect(block).not.toContain('TINHEAD_URL');
    // Nothing long and opaque at all now: the label is a word the person chose.
    expect(block).not.toMatch(/[A-Za-z0-9_-]{30,}/);
  });

  it('describes the same server both ways', () => {
    expect(JSON.parse(configBlock(LABEL)).mcpServers[serverName(LABEL)]).toEqual(mcpConfig(LABEL));
  });
});
