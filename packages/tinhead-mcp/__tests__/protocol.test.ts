import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cryptoReady, generateDek, generateKeyId } from '../../../src/crypto';
import { mintGrant, openGrantBundle } from '../../../src/agent/grants';
import { GrantScope } from '../../../src/agent/types';
import { NodeMap } from '../../../src/model/tree';
import { normalizeNode } from '../../../src/model/types';
import { Corpus, DoorApi } from '../src/corpus';
import { createSession } from '../src/session';
import { buildServer } from '../src/server';

/**
 * SPEC-AGENT §18 — the door as a real MCP server, driven by a real MCP client.
 *
 * `door.test.ts` proves the tools do the right thing against a live app engine.
 * This proves the other half, which is easy to assume and expensive to be wrong
 * about: that what a client sees over the protocol is a usable surface —
 * `tools/list` returns schemas and annotations, `tools/call` returns content, a
 * refusal comes back as `isError` with a sentence rather than a transport
 * failure, and a read-only grant is not even SHOWN the write tools.
 *
 * The corpus here is a fixture rather than a pulled one: the wire is what is
 * under test, and `door.test.ts` already owns the pull.
 */

const USER = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  await cryptoReady;
});

function fixture(): Corpus {
  const nodes: NodeMap = new Map();
  for (const n of [
    { id: 'root', parentId: null, title: 'Tinhead' },
    { id: 'cal', parentId: 'root', title: 'Calendar', body: 'the dates lens' },
    { id: 't1', parentId: 'cal', title: 'week view', taskAt: 1, completedAt: null },
  ]) {
    const full = normalizeNode(n);
    nodes.set(full.id, full);
  }
  return { nodes, counter: 1, keyId: 'k', versions: new Map(), manifest: new Map() };
}

/** A server that would refuse everything — nothing here reaches it. */
const deadApi: DoorApi = {
  fetchManifest: async () => {
    throw new Error('not used');
  },
  fetchNodeMeta: async () => {
    throw new Error('not used');
  },
  fetchNodes: async () => {
    throw new Error('not used');
  },
  casPushBatch: async () => {
    throw new Error('not used');
  },
};

async function connectClient(scope: GrantScope) {
  const dek = generateDek();
  const keyId = generateKeyId();
  const { token, row } = mintGrant(dek, USER, keyId, { name: 'claude code', scope });
  const grant = openGrantBundle(token, {
    id: row.id,
    userId: USER,
    keyId,
    wrapped: row.wrapped,
    salt: row.salt,
    scope: row.scope,
    scopeRev: row.scopeRev,
  });
  // The session pulls through `pullCorpus`, which is stubbed below to serve the
  // fixture — so the session is built exactly as production builds it.
  const session = createSession({ api: deadApi, grant, name: 'claude code' });
  const server = buildServer(session);

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, session };
}

jest.mock('../src/corpus', () => {
  const actual = jest.requireActual('../src/corpus');
  return { ...actual, pullCorpus: jest.fn() };
});

describe('the door over the MCP protocol', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { pullCorpus } = require('../src/corpus') as { pullCorpus: jest.Mock };
    pullCorpus.mockImplementation(async () => fixture());
  });

  it('lists tools with schemas and annotations a client can actually use', async () => {
    const { client } = await connectClient({ branches: ['cal'], write: true, reads: 'branch' });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        'compile_subtree',
        'complete_thought',
        'create_thought',
        'delete_thought',
        'find_tasks',
        'get_level',
        'get_path',
        'get_root',
        'get_thought',
        'search_thoughts',
        'set_task',
        'set_when',
        'update_thought',
      ].sort()
    );

    for (const t of tools) {
      expect(t.description && t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations).toBeDefined();
    }
    // The annotations reviewers look for, and clients use to decide prompting.
    expect(tools.find((t) => t.name === 'get_root')!.annotations!.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'delete_thought')!.annotations!.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'create_thought')!.annotations!.readOnlyHint).toBe(false);
    // §1.7 — the limits are where the MODEL reads them.
    expect(tools.find((t) => t.name === 'get_level')!.description).toMatch(/at most 50/);
    expect(tools.find((t) => t.name === 'compile_subtree')!.description).toMatch(/[Tt]runcates/);
    expect(tools.find((t) => t.name === 'update_thought')!.description).toMatch(/PRIVATE FIELDS/);
    expect(tools.find((t) => t.name === 'get_root')!.description).toMatch(/START HERE/);
    expect(tools.find((t) => t.name === 'find_tasks')!.description).toMatch(/at most 100/);
    // The two shortening limits are the ones a model must know about, because a
    // clipped field it was not told about is indistinguishable from a whole one.
    expect(tools.find((t) => t.name === 'search_thoughts')!.description).toMatch(/shortened/);
    expect(tools.find((t) => t.name === 'get_level')!.description).toMatch(/shortened/);
  });

  it('a read-only grant is not even SHOWN the write tools', async () => {
    const { client } = await connectClient({ branches: ['cal'], write: false, reads: 'everything' });
    const { tools } = await client.listTools();
    expect(tools.every((t) => t.annotations!.readOnlyHint === true)).toBe(true);
    expect(tools.find((t) => t.name === 'create_thought')).toBeUndefined();
    expect(tools).toHaveLength(7);
  });

  it('a call returns content the model can read', async () => {
    const { client } = await connectClient({ branches: ['cal'], write: false, reads: 'branch' });
    const res = await client.callTool({ name: 'get_root', arguments: {} });
    const content = res.content as { type: string; text: string }[];
    expect(content[0].type).toBe('text');
    const root = JSON.parse(content[0].text) as Record<string, unknown>;
    expect((root.roots as Record<string, unknown>[])[0].title).toBe('Calendar');
    expect(root.may_write).toMatch(/read-only/);
  });

  it('a connection with no branches yet is a usable surface that refuses in words', async () => {
    const { client } = await connectClient({ branches: [], write: true, reads: 'branch' });
    // The tools are all there — the connection works; it has just been given
    // nothing. A client that showed no tools would read as a broken install.
    const { tools } = await client.listTools();
    expect(tools.length).toBe(13);

    const res = await client.callTool({ name: 'get_thought', arguments: { id: 't1' } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/has not been given a branch yet/);
  });

  /**
   * The two primitives this package shipped without. A client cannot surface a
   * slash command or an `@` entry that the server never declares, so every
   * assertion here is about what a real client would actually SEE.
   */
  describe('prompts — the slash commands', () => {
    it('are declared with their arguments, and render a message in the person’s voice', async () => {
      const { client } = await connectClient({ branches: ['cal'], write: true, reads: 'branch' });
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name).sort()).toEqual(['capture', 'outstanding', 'work_on']);

      const workOn = prompts.find((p) => p.name === 'work_on')!;
      expect(workOn.arguments!.find((a) => a.name === 'branch')!.required).toBe(true);
      expect(workOn.arguments!.find((a) => a.name === 'how_many')!.required).toBe(false);

      const got = await client.getPrompt({ name: 'work_on', arguments: { branch: 'Calendar' } });
      const text = (got.messages[0].content as { text: string }).text;
      expect(got.messages[0].role).toBe('user');
      expect(text).toContain('Calendar');
      // It must name the tool that resolves words to a branch, or the agent
      // searches and picks one itself — the thing this whole surface removes.
      expect(text).toMatch(/find_tasks/);
      expect(text).toMatch(/"name"/);
      // And carry the standing rules a tool description cannot, because they
      // span calls.
      expect(text).toMatch(/[Dd]o not tick anything off/);
      // No orientation: `about.ts` says what Tinhead is, and a third copy here
      // is the drift the doc's gotcha forbids.
      expect(text).not.toContain('Tinhead is a thought-tree app');
    });

    it('a read-only grant is not shown a command that could only refuse', async () => {
      const { client } = await connectClient({ branches: ['cal'], write: false, reads: 'branch' });
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name).sort()).toEqual(['outstanding', 'work_on']);
      expect(prompts.find((p) => p.name === 'capture')).toBeUndefined();
    });

    it('a missing required argument fails with a sentence naming what is missing', async () => {
      const { client } = await connectClient({ branches: ['cal'], write: true, reads: 'branch' });
      await expect(client.getPrompt({ name: 'work_on', arguments: {} })).rejects.toThrow(/branch/);
      await expect(client.getPrompt({ name: 'nope', arguments: {} })).rejects.toThrow(/no such prompt/);
    });
  });

  describe('resources — the @ menu', () => {
    it('lists the branch and what is in it, with the path that tells twins apart', async () => {
      const { client } = await connectClient({ branches: ['cal'], write: false, reads: 'branch' });
      const { resources } = await client.listResources();

      const cal = resources.find((r) => r.uri.endsWith('/cal'))!;
      expect(cal).toBeTruthy();
      expect(cal.name).toBe('Calendar');
      expect(cal.mimeType).toBe('text/markdown');
      // The description is the ONLY thing separating two entries of the same
      // name in a menu, so it must carry the open count.
      expect(cal.description).toMatch(/1 inside, 1 open/);
      // Children are addressable too — "the Calendar list" is usually a level in.
      expect(resources.find((r) => r.uri.endsWith('/t1'))!.name).toBe('week view');
      // Never above the granted branch: the root is in the corpus and out of scope.
      expect(resources.find((r) => r.uri.endsWith('/root'))).toBeUndefined();
      expect(JSON.stringify(resources)).not.toContain('Tinhead');
    });

    it('reads one as a document, and refuses a uri that is not ours', async () => {
      const { client } = await connectClient({ branches: ['cal'], write: false, reads: 'branch' });
      const res = await client.readResource({ uri: 'tinhead://thought/cal' });
      const text = (res.contents[0] as { text: string }).text;
      expect(text).toContain('Calendar');
      expect(text).toContain('week view');

      await expect(client.readResource({ uri: 'file:///etc/passwd' })).rejects.toThrow(
        /not a Tinhead thought/
      );
      // Out of scope goes through compile_subtree's own check, not a second one.
      await expect(client.readResource({ uri: 'tinhead://thought/root' })).rejects.toThrow(
        /outside this grant/
      );
    });
  });

  it('a refusal is a RESULT with a sentence, not a transport failure', async () => {
    const { client } = await connectClient({ branches: ['cal'], write: false, reads: 'branch' });
    // Outside the branch: the process holds the row and still says no.
    const res = await client.callTool({ name: 'get_thought', arguments: { id: 'root' } });
    expect(res.isError).toBe(true);
    const content = res.content as { text: string }[];
    expect(content[0].text).toMatch(/outside this grant/);

    // And an unknown tool does not take the connection down either.
    const bogus = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect(bogus.isError).toBe(true);
  });
});
