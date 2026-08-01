/**
 * `tinhead-mcp` — the MCP binding. Deliberately the thinnest file here.
 *
 * Everything that decides anything lives in `session.ts`, `tools.ts`,
 * `writeTools.ts` and [core]; this translates a tool table into MCP and back.
 * If a rule ever appears in this file, it is in the wrong place.
 *
 * The official SDK speaks the protocol rather than a hand-rolled JSON-RPC loop:
 * interop with real clients is the one thing worth a dependency here, and
 * "we reimplemented the protocol" is a question nobody should have to ask of a
 * package whose pitch is auditability.
 */

import { Server } from '@modelcontextprotocol/sdk/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Session } from './session';
import { ABOUT_TINHEAD } from './about';
import { promptsFor, renderPrompt } from './prompts';
import { idFromUri, listResources, uriFor } from './resources';

export function buildServer(session: Session): Server {
  const server = new Server(
    { name: 'tinhead', version: '0.1.0' },
    // `instructions` rides the initialize response, so it is the one thing an
    // agent has read BEFORE it chooses a first tool — and under MCP tool search
    // (on by default in Claude Code) it is read while the tool SCHEMAS are still
    // deferred, which makes it the routing signal for whether this server is the
    // answer at all. Not every client surfaces it, which is why `get_root`
    // repeats it from the same constant.
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: ABOUT_TINHEAD,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: session.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = session.tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text' as const, text: `no such tool: ${req.params.name}` }] };
    }
    try {
      const text = await tool.run((req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      // A refusal is a RESULT, not a protocol error: the model should read why
      // and change what it does, not see the transport fail. Scope refusals,
      // integrity refusals and gateway refusals all land here already worded.
      return {
        isError: true,
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
      };
    }
  });

  // ---- prompts: the slash commands a client discovers rather than is told ----

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: promptsFor(session.grant.scope).map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments.map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required === true,
      })),
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const p = promptsFor(session.grant.scope).find((x) => x.name === req.params.name);
    if (!p) throw new Error(`no such prompt: ${req.params.name}`);
    return {
      description: p.description,
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: renderPrompt(p, (req.params.arguments ?? {}) as Record<string, unknown>),
          },
        },
      ],
    };
  });

  // ---- resources: the `@` menu, where the person disambiguates for free ----

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const c = await session.corpus();
    return { resources: listResources(c.nodes, session.grant.scope) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const id = idFromUri(req.params.uri);
    if (!id) throw new Error(`not a Tinhead thought: ${req.params.uri}`);
    // Reads go through the TOOL, not around it: `compile_subtree` already
    // carries the scope check, the covered-field rule and the cap, and a second
    // read path here would be a second place for any of those to be forgotten.
    const compile = session.tools.find((t) => t.name === 'compile_subtree');
    if (!compile) throw new Error('this connection cannot read that');
    const out = JSON.parse(await compile.run({ id })) as { text: string | null };
    return {
      contents: [
        {
          uri: uriFor(id),
          mimeType: 'text/markdown',
          text: out.text ?? '(nothing inside this thought yet)',
        },
      ],
    };
  });

  return server;
}

export async function serve(session: Session): Promise<void> {
  const server = buildServer(session);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The key dies with the process, and the process dies with its client —
  // there is no daemon here and nothing to leave running (SPEC-AGENT §14).
  //
  // `session.close()` wipes the DEK, so it must run before anything else and
  // must run exactly once: two signals in quick succession (a shell sending
  // SIGINT then SIGTERM) would otherwise wipe an already-wiped buffer and, worse,
  // race the transport teardown.
  //
  // NOT `process.exit()`. Killing the process from inside a signal handler while
  // stdio handles are still closing is what produced
  // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` on Windows — a
  // libuv abort that looks to the user like the door crashed. Closing the
  // transport and setting an exit code lets the loop drain and the process end
  // on its own, which is both quieter and the same outcome.
  let closing = false;
  const done = () => {
    if (closing) return;
    closing = true;
    session.close();
    process.exitCode = 0;
    void transport.close().catch(() => {
      // Nothing useful to say: the key is already gone and we are on the way out.
    });
  };
  process.on('SIGINT', done);
  process.on('SIGTERM', done);
}
