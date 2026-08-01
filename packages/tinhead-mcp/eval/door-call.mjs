#!/usr/bin/env node
/**
 * One tool call against the REAL door, from the command line.
 *
 *     node packages/tinhead-mcp/eval/door-call.mjs get_root
 *     node packages/tinhead-mcp/eval/door-call.mjs find_tasks '{"state":"open"}'
 *     node packages/tinhead-mcp/eval/door-call.mjs --list
 *
 * Why this exists: `door.test.ts` and `protocol.test.ts` both run against
 * `FakeSync` or a fixture, so the doc's standing instruction is *"if you change
 * the wire, re-run the live chain by hand"* — and by hand meant writing a
 * throwaway client each time. This is that client, kept.
 *
 * It spawns the BUILT cli over stdio exactly as an MCP host does, which is also
 * what makes it useful for evaluating the surface: an editor's MCP connection is
 * established once per session and goes on serving the build it started with, so
 * a rebuilt door cannot be observed through it. Every invocation here is a fresh
 * process on current `dist/`.
 *
 * Each call is a full connect — gateway redeem, DEK unwrap, §7 verified read —
 * because the door is stateless by design. Expect a second or two, and note that
 * this is the honest per-session cost, not an artifact of the harness.
 *
 * Reads the account the same way the CLI does (`connections.json` + the OS
 * store). It holds no secret of its own and writes nothing to disk.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '..', 'dist', 'packages', 'tinhead-mcp', 'src', 'cli.js');

const [, , toolArg, argsArg] = process.argv;
if (!toolArg) {
  console.error('usage: door-call.mjs <tool> [json-args]   |   door-call.mjs --list');
  process.exit(2);
}

let args = {};
if (argsArg) {
  try {
    args = JSON.parse(argsArg);
  } catch {
    console.error(`the second argument must be JSON — got: ${argsArg}`);
    process.exit(2);
  }
}

const transport = new StdioClientTransport({ command: process.execPath, args: [cli] });
const client = new Client({ name: 'door-call', version: '0' }, { capabilities: {} });

try {
  await client.connect(transport);

  if (toolArg === '--list') {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}\t${t.description.slice(0, 100)}…`);
    console.log(`\n${tools.length} tools`);
  } else if (toolArg === '--prompts') {
    const { prompts } = await client.listPrompts();
    for (const p of prompts) {
      const a = p.arguments?.map((x) => (x.required ? `<${x.name}>` : `[${x.name}]`)).join(' ') ?? '';
      console.log(`/mcp__tinhead__${p.name} ${a}\n    ${p.description}`);
    }
    console.log(`\n${prompts.length} prompts`);
  } else if (toolArg === '--prompt') {
    const { name, ...rest } = args;
    const got = await client.getPrompt({ name, arguments: rest });
    for (const m of got.messages) console.log(m.content.text);
  } else if (toolArg === '--resources') {
    const { resources } = await client.listResources();
    for (const r of resources) console.log(`${r.name}\n    ${r.description}\n    ${r.uri}`);
    console.log(`\n${resources.length} resources`);
  } else if (toolArg === '--read') {
    const res = await client.readResource({ uri: args.uri });
    for (const c of res.contents) console.log(c.text ?? JSON.stringify(c));
  } else {
    const res = await client.callTool({ name: toolArg, arguments: args });
    // A refusal is a RESULT here, not a throw — surface it as the door meant it.
    if (res.isError) console.error('[isError]');
    for (const c of res.content ?? []) console.log(c.type === 'text' ? c.text : JSON.stringify(c));
    if (res.isError) process.exitCode = 1;
  }
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
