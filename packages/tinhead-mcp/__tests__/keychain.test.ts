import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  forgetGrant,
  listGrants,
  loadToken,
  purgeCodeShapedNames,
  rememberGrant,
  stateDir,
  storeToken,
} from '../src/keychain';

/**
 * SPEC-AGENT §4.5 — what the state directory is allowed to contain.
 *
 * The test that matters here is the one the live setup failed: a caller-supplied
 * string used to become a FILENAME, so when the founder passed his token where
 * the connection id belonged, the token was written out in the clear beside the
 * DPAPI-sealed copy of itself. Sealing protects a file's contents and says
 * nothing about its name.
 *
 * The backend under test is whichever one this machine has (DPAPI here,
 * libsecret or a plaintext fallback in CI). That is deliberate: every assertion
 * below is about names and about the migration, both of which must hold on all
 * three, and none of them assumes a store succeeded.
 */

// The state dir is redirected through the environment, which `stateDir()` reads
// on every call — except on macOS, where it is `~/Library` and nothing else, and
// a test has no business writing there.
const canRedirect = platform() !== 'darwin';
const suite = canRedirect ? describe : describe.skip;

const GRANT = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'kQ8Zr2Yb5xJfL0pWc7nT-dV3aH6mS9eU1gK4oR8iC2w';

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tinhead-mcp-keychain-'));
  process.env.APPDATA = tmp;
  process.env.XDG_STATE_HOME = tmp;
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/** Every name in the state dir, so a leak can be looked for rather than assumed. */
const names = async (): Promise<string[]> => readdir(stateDir()).catch(() => []);

suite('the token at rest', () => {
  jest.setTimeout(60000); // a DPAPI round trip is two PowerShell starts

  afterEach(async () => {
    for (const n of await names()) await rm(join(stateDir(), n), { force: true });
  });

  it('round-trips, and writes neither the token nor the id into a name', async () => {
    await storeToken(GRANT, TOKEN);
    const got = await loadToken(GRANT);
    expect(got?.token).toBe(TOKEN);

    const dir = await names();
    expect(dir.length).toBeGreaterThan(0);
    for (const n of dir) {
      expect(n).not.toContain(TOKEN);
      expect(n).not.toContain(GRANT);
    }
  });

  it('cannot write a token into a filename even when one is passed as the id', async () => {
    // Exactly the founder's mis-paste. The name is derived, so the confusion
    // costs him a refusal from the gateway and nothing else.
    await storeToken(TOKEN, TOKEN);
    for (const n of await names()) expect(n).not.toContain(TOKEN);
    expect((await loadToken(TOKEN))?.token).toBe(TOKEN);
  });

  it('refuses to follow a separator out of the state dir', async () => {
    await storeToken('../../escaped', TOKEN);
    for (const n of await names()) expect(n).not.toContain('escaped');
    expect((await loadToken('../../escaped'))?.token).toBe(TOKEN);
  });

  it('migrates a login made under the old plain name, and leaves nothing behind', async () => {
    await writeFile(join(stateDir(), `${GRANT}.token`), TOKEN, 'utf8');

    const got = await loadToken(GRANT);
    expect(got?.token).toBe(TOKEN);

    const dir = await names();
    expect(dir).not.toContain(`${GRANT}.token`);
    expect(dir.length).toBeGreaterThan(0);
    // And it is still readable from its new home on the next start.
    expect((await loadToken(GRANT))?.token).toBe(TOKEN);
  });

  it('has nothing to give when nothing was stored', async () => {
    expect(await loadToken('22222222-2222-4222-8222-222222222222')).toBeNull();
  });
});

// A blob that exists and will not open is DPAPI-shaped; there is nothing to
// forge on the other two backends.
const onWindows = platform() === 'win32' ? it : it.skip;

suite('a sealed blob this machine cannot open', () => {
  afterEach(async () => {
    for (const n of await names()) await rm(join(stateDir(), n), { force: true });
  });

  /** The token AND what the process told the person while it looked for it. */
  async function loadAndListen(): Promise<{ got: Awaited<ReturnType<typeof loadToken>>; said: string }> {
    let said = '';
    const spy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        said += String(chunk);
        return true;
      });
    try {
      return { got: await loadToken(GRANT), said };
    } finally {
      spy.mockRestore();
    }
  }

  /** Leave a `.dpapi` blob under the derived name that cannot possibly unseal. */
  async function corruptTheSeal(): Promise<void> {
    await storeToken(GRANT, TOKEN);
    const sealed = (await names()).find((n) => n.endsWith('.dpapi'));
    expect(sealed).toBeDefined();
    await writeFile(join(stateDir(), sealed as string), 'not a DPAPI blob', 'utf8');
  }

  onWindows('says so, once, when there is nothing else to try', async () => {
    await corruptTheSeal();
    const { got, said } = await loadAndListen();
    expect(got).toBeNull();
    expect(said).toContain('cannot unseal');
  });

  onWindows('stays quiet when the legacy copy answers instead', async () => {
    // The bug this replaced: the warning was written the moment the derived
    // name failed, and the next line migrated a working token successfully.
    await corruptTheSeal();
    await writeFile(join(stateDir(), `${GRANT}.token`), TOKEN, 'utf8');

    const { got, said } = await loadAndListen();
    expect(got?.token).toBe(TOKEN);
    expect(said).not.toContain('cannot unseal');
  });
});

suite('the leak the old setup left behind', () => {
  afterEach(async () => {
    for (const n of await names()) await rm(join(stateDir(), n), { force: true });
  });

  it('deletes a file whose NAME is a code, and nothing else', async () => {
    // The founder's disk, reproduced: a token pasted where the id belonged, so
    // the secret became the filename. Nothing will ever ask for it again.
    await writeFile(join(stateDir(), `${TOKEN}.dpapi`), 'sealed-bytes', 'utf8');
    await writeFile(join(stateDir(), `${TOKEN}.token`), TOKEN, 'utf8');
    // Everything a working machine holds, none of which may be touched.
    await storeToken(GRANT, TOKEN);
    await rememberGrant({ grantId: GRANT, url: 'https://a.example/functions/v1/grant_gateway' });
    const legacy = `${GRANT}.dpapi`;
    await writeFile(join(stateDir(), legacy), 'someone-elses-legacy-login', 'utf8');

    expect(await purgeCodeShapedNames()).toBe(2);

    const left = await names();
    for (const n of left) expect(n).not.toContain(TOKEN);
    expect(left).toContain('connections.json');
    expect(left).toContain(legacy);
    expect((await loadToken(GRANT))?.token).toBe(TOKEN);
  });

  it('is a no-op on a clean machine, and on no machine at all', async () => {
    expect(await purgeCodeShapedNames()).toBe(0);
    process.env.APPDATA = join(tmp, 'never-created');
    process.env.XDG_STATE_HOME = join(tmp, 'never-created');
    expect(await purgeCodeShapedNames()).toBe(0);
    process.env.APPDATA = tmp;
    process.env.XDG_STATE_HOME = tmp;
  });
});

suite('the non-secret half', () => {
  afterEach(async () => {
    for (const n of await names()) await rm(join(stateDir(), n), { force: true });
  });

  it('remembers a connection and replaces it by id', async () => {
    await rememberGrant({ grantId: GRANT, url: 'https://a.example/functions/v1/grant_gateway' });
    await rememberGrant({ grantId: 'other', url: 'https://b.example/functions/v1/grant_gateway' });
    await rememberGrant({ grantId: GRANT, url: 'https://c.example/functions/v1/grant_gateway' });

    const all = await listGrants();
    expect(all).toHaveLength(2);
    expect(all.find((g) => g.grantId === GRANT)?.url).toBe('https://c.example/functions/v1/grant_gateway');
  });

  it('drops a row that would send the code somewhere unencrypted', async () => {
    await writeFile(
      join(stateDir(), 'connections.json'),
      JSON.stringify({
        connections: [
          { grantId: 'plain', url: 'http://evil.example/gateway' },
          { grantId: 'fine', url: 'https://ok.example/gateway' },
        ],
      }),
      'utf8'
    );
    expect(await listGrants()).toEqual([{ grantId: 'fine', url: 'https://ok.example/gateway' }]);
  });

  it('reads a missing or damaged file as no connections at all', async () => {
    expect(await listGrants()).toEqual([]);
    await writeFile(join(stateDir(), 'connections.json'), 'not json', 'utf8');
    expect(await listGrants()).toEqual([]);
  });
});

/**
 * Forgetting a connection — the papercut this closes, and the thing it must not
 * get wrong.
 *
 * A revoked grant used to stay here for ever. That is worse than untidy: the
 * connection count is what decides whether this machine can pick a connection at
 * all, so ONE dead row made every live one ambiguous and unusable without an
 * explicit `TINHEAD_GRANT` in a config file.
 *
 * The risk in the fix is deleting the wrong thing, so every case below asserts
 * what SURVIVED as well as what went.
 */
suite('forgetting a connection', () => {
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const A = 'https://a.example/functions/v1/grant_gateway';
  const B = 'https://b.example/functions/v1/grant_gateway';

  afterEach(async () => {
    for (const n of await names()) await rm(join(stateDir(), n), { force: true });
  });

  it('takes the row AND the stored code, and leaves the other connection whole', async () => {
    await storeToken(GRANT, TOKEN);
    await storeToken(OTHER, TOKEN);
    await rememberGrant({ grantId: GRANT, url: A });
    await rememberGrant({ grantId: OTHER, url: B });

    expect(await forgetGrant(GRANT)).toBe(true);

    // The row is gone…
    expect(await listGrants()).toEqual([{ grantId: OTHER, url: B }]);
    // …and so is the secret, which is the half that would otherwise be found by
    // a later login under the same id and preferred over the fresh one.
    expect(await loadToken(GRANT)).toBeNull();
    // The survivor is untouched in both halves.
    expect((await loadToken(OTHER))?.token).toBe(TOKEN);
  });

  it('is what makes a single remaining connection usable again', async () => {
    // The exact papercut: two rows, one of them dead, and the live one cannot be
    // resolved because the COUNT is what `resolveConnection` refuses on.
    await rememberGrant({ grantId: GRANT, url: A });
    await rememberGrant({ grantId: OTHER, url: B });
    expect(await listGrants()).toHaveLength(2);

    await forgetGrant(GRANT);
    expect(await listGrants()).toHaveLength(1);
  });

  it('deletes a code stored under the PRE-DIGEST name too', async () => {
    // A login made before `storeKey` existed. Forgetting the row while leaving
    // this behind is the shadowing bug the store already had to fix once.
    await rememberGrant({ grantId: GRANT, url: A });
    await writeFile(join(stateDir(), `${GRANT}.token`), TOKEN, 'utf8');

    await forgetGrant(GRANT);

    expect(await names()).not.toContain(`${GRANT}.token`);
    expect(await loadToken(GRANT)).toBeNull();
  });

  it('reports honestly when there was no such row, and still cleans up after it', async () => {
    // `connections.json` hand-edited or lost, with the secret still on disk —
    // the only route left to that secret.
    await storeToken(GRANT, TOKEN);
    expect((await loadToken(GRANT))?.token).toBe(TOKEN);

    expect(await forgetGrant(GRANT)).toBe(false);
    expect(await loadToken(GRANT)).toBeNull();
  });

  it('touches nothing on a machine that has no connections', async () => {
    expect(await forgetGrant(GRANT)).toBe(false);
    expect(await listGrants()).toEqual([]);
  });

  it('cannot be walked out of the state dir by a separator in the id', async () => {
    const outside = join(tmp, 'not-ours.token');
    await writeFile(outside, 'someone else’s file', 'utf8');
    await rememberGrant({ grantId: GRANT, url: A });

    await forgetGrant('../not-ours');

    // Still there: `storeKey` hashes, and `legacyKey` refuses a separator, so no
    // caller string reaches a path (the same rule `storeToken` is held to).
    await expect(readFile(outside, 'utf8')).resolves.toContain('someone else');
    expect(await listGrants()).toHaveLength(1);
  });
});
