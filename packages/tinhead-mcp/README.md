# tinhead-mcp

A local MCP server that lets an agent read and work on your Tinhead thoughts — with the app
closed, and without Tinhead's servers ever holding a key they could use.

This package is open source **because it is the part that holds your key.** The app is closed;
this is not, and it is the artifact worth auditing. If any claim below is false, it is false in
[the source](https://github.com/Tinhead-app/tinhead-mcp), in code you can read — including the
crypto itself, which is published with it.

---

## What it does

Give an agent a branch of your tree — a project, a todo list, a client — and it can read what
is in there and work on it. The scene it was built for:

> *"work on the todo list under Calendar"* — and it finds the branch, reads it, ticks things
> off and adds notes, with nothing else running.

A connection can hold **several branches**, and you add and remove them whenever you like without
issuing a new code. A brand-new connection holds **none**, and reaches nothing at all until you
give it one.

## What leaves your machine

| To | What | When |
|---|---|---|
| Tinhead's server | thought ciphertext + a MAC, exactly as your phone sends | on every call |
| Tinhead's server | a per-grant authenticator (**not** your code) | on every call |
| Your model provider | whatever the agent reads, in its context | per request you make |
| Anywhere | your encryption key, your sync passphrase, or a grant code | **never** |
| Anywhere | a private (covered) detail field's plaintext | **never** |

The third row is the honest one: this replaces pasting a thought into a chat window, and it is
the same exposure. That is the trade the door exists to make.

The fourth row is meant literally, and it took two fixes to become true. Your grant code is never a
command-line argument and never a literal inside a script — on Windows it is fed to PowerShell on
**stdin** under a constant script, because a command line lands in 4688 audit events and a script
body lands in 4104 ScriptBlock logs, both of which ordinary endpoint tooling ships off the machine.
macOS and Linux feed `security` and `secret-tool` on stdin for the same reason. Whichever store
takes it is then **read back before this tool tells you where it went** — a store that cannot be
read is a plaintext fallback that has not admitted itself — and the losing copy is deleted, so a
stale token in one place can never shadow the one you just pasted into the other.

The second fix is the **name**. Sealing protects a file's contents and has nothing to say about
what the file is called, and this tool used to name each file after the connection id it was
handed — so a code pasted where an id belonged was written out in the clear beside the sealed copy
of itself. That happened, to the person who designed the feature, which is why the setup below is
now one string and cannot be pasted into the wrong slot. Names are a digest of the id either way,
and `login` deletes any file an older version left named after a code. See `src/keychain.ts`.

## The key, and why the server cannot use it

Inside that setup code is a **256-bit secret, shown once**. Two independent keys are derived from
it, one-way, in `src/agent/grants.ts` in the Tinhead repository:

```
code
  ├─ grantAuth   SENT to the server on every call. Authenticates. Opens nothing.
  └─ grantWrap   NEVER sent. This is what unwraps your key, on this machine.
```

The server stores a *hash of* `grantAuth` and your encryption key **wrapped under `grantWrap`**.
So a full breach of Tinhead yields a hash and a blob locked with a secret the server has never
received — and neither has anyone else, because the code went from the screen to your keychain.

Which branches a connection may touch is sealed **separately**, under your account key rather than
the code — which is what lets you hand it a branch, or take one back, long after the code was
shown. The server stores that sealed too, and cannot read or widen it.

You can check all of this. `deriveGrantAuth` and `deriveGrantWrap` are two `crypto_kdf` subkeys off
one master (libsodium, BLAKE2b); `gateway.ts` sends `auth` and nothing else; and a proxy in front
of this process will show you rows leaving as ciphertext.

**What the scope is not.** This process holds your account key, so the branches a grant is limited
to are enforced *here*, by this code, not by mathematics. A compromised machine reads everything.
We say so plainly rather than implying a cryptographic boundary we do not have — see
`src/scope.ts`, which says it in its own header.

## Install

Three steps, in Tinhead and then here, and people miss the third one.

**1. Make the connection.** In Tinhead: `Settings › Plugins › MCP`. That creates the connection and
shows you one **setup code**, once. It carries the connection, its address and its code together,
so there is nothing to match up and nothing to keep.

**2. Store it:**

```bash
npx tinhead-mcp login
```

No arguments — paste the setup code when asked. The secret inside it goes into your OS credential
store (the macOS keychain, DPAPI on Windows, or libsecret on Linux); the two non-secret parts go
into `connections.json` in the state directory, which is how the next step needs no settings.
**If no credential store is available the code goes into a plain file in that same directory and
this tool tells you so, every time it starts.** A silent downgrade would be the same lie as putting
it in a config file. (That file is written `0600` on macOS and Linux; on Windows the mode bits are
a no-op and it is protected by your user profile's ACL and nothing else.)

**3. Register it with your agent.** `login` prints the exact line for your machine — copy that
rather than this. On macOS and Linux it looks like:

```bash
claude mcp add tinhead -- npx -y tinhead-mcp --as default
```

**On Windows it is a different command, and this is not a typo:**

```powershell
claude mcp add-json tinhead '{\"command\":\"npx\",\"args\":[\"-y\",\"tinhead-mcp\",\"--as\",\"default\"]}'
```

`claude` on Windows is an npm-generated PowerShell shim, and the `--` that stops option parsing is
lost before it reaches the CLI — so the first command fails there with `error: unknown option '-y'`,
including in its own documentation's form. `add-json` takes one argument and needs no separator, and
the backslashes are because PowerShell strips bare double quotes out of a native command's arguments.

Either way: no secrets and no address, because this machine already knows which connection that is.
The line is safe to paste anywhere — the code is in your credential store and the address is in
`connections.json`.

Using a different MCP client? Add this to its config instead:

```json
{
  "mcpServers": {
    "tinhead": {
      "command": "npx",
      "args": ["-y", "tinhead-mcp", "--as", "default"]
    }
  }
}
```

**`--as` names a connection, and that name is yours.** `default` is what bare `login` uses; a second
connection gets its own with `npx tinhead-mcp login --as work`, and registers as a separate server
(`tinhead-work`) so the two never collide.

The name is the only thing your config carries, and that is deliberate. **It keeps working when the
connection behind it does not:** revoke a connection in Tinhead, issue a fresh code, run
`npx tinhead-mcp login --as <the same name>`, and every config naming it resolves to the new one
with nothing to edit. An earlier version of this tool put the connection **id** in the config
instead. That was correct the day it was printed and dead after the next revoke or reissue — and
because a config is a file this tool cannot reach, the only symptom was an MCP client that quietly
stopped listing any tools.

(`TINHEAD_GRANT` and `TINHEAD_URL` still work as an override — the pair points the door at a gateway
of your own, which is the reason they exist. `TINHEAD_GRANT` alone is the pre-`--as` form; it is
still honoured, and the server tells you what to replace it with.)

**4. Give it a branch.** A connection with no branches connects and can then do nothing. In
Tinhead, open the thought you want the agent to work in and choose `Options › Give access`. Repeat
for as many branches as you want it to reach; remove one the same way. The setup code never
changes, and you do not need it again.

## The tools

Start with `get_root` — every other tool takes an id, and that is the one that gives you one.

| Tool | |
|---|---|
| `get_root` | the grant: its branches, what it may do, and the first level inside each |
| `search_thoughts` | words, prefixes and misspellings — each hit with its path, task state and counts |
| `get_level` | one level, 50 at a time |
| `find_tasks` | the work under a thought — open by default, with locations |
| `get_path` | where a thought sits |
| `get_thought` | one thought in full |
| `compile_subtree` | **prefer this** — a whole branch as one document, in one call |
| `create_thought` · `update_thought` | words |
| `complete_thought` · `set_task` · `set_when` | ticking off, marking, dating |
| `delete_thought` | into the app's bin, which is the undo |

A read-only grant is not shown the write tools at all.

## Commands

Your agent discovers these from the server — nothing to configure. In Claude Code they appear when
you type `/`:

| Command | |
|---|---|
| `/mcp__tinhead__work_on <branch> [how_many]` | work on the open tasks in one branch, named in words |
| `/mcp__tinhead__outstanding [branch]` | everything still open, grouped by where it lives |
| `/mcp__tinhead__capture <text> [branch]` | put a thought in the right place, in your voice |

`capture` is not shown to a read-only connection.

These exist because your branch names are ordinary words. "Work on the Calendar list" could mean
your thoughts or any file on your machine; `/mcp__tinhead__work_on Calendar` can only mean your
thoughts, so the agent never has to guess which you meant.

## Pointing at a branch

Type `@` and your branches appear alongside your files, each with its location and how much is open
inside it:

```
@tinhead:tinhead://thought/<id>
```

Two branches with the same name are told apart there, by you, in the moment — which is cheaper and
more accurate than an agent working it out afterwards. Picking one hands the agent that whole branch
as a document.

## Honest limits

- **A new connection reaches nothing.** Until you give it a branch, every tool refuses and says so.
  That is the intended state, not a fault.
- **Every connect reads your whole corpus.** This process is spawned by your MCP client and dies
  with it, so it keeps no cursor and cannot do the incremental sync a phone does. On a large tree
  that is a few seconds and a few MB at startup.
- **It needs a Tinhead account with sync unlocked.** A local-only tree has no server to read from.
- **Revoking stops the next process, not one already connected.** A grant that has been used has
  already handed this machine the key. That is what revocation can do until Tinhead ships key
  rotation, and the app's own revoke row says so. Once you have revoked one, take it off this
  machine too — `npx tinhead-mcp forget` removes the connection **and deletes its stored code**.
  Worth doing rather than leaving: this server refuses to guess when a machine holds more than one
  connection whose name it was not told, and a dead one still counts.
- **Forgetting a connection breaks the configs that name it**, and this tool cannot edit them for
  you. `forget` says which name just became unresolvable; either log a replacement in under that
  name (no config change) or remove that server from your client.
- **Level order is oldest-first**, which may not be the order you see in the app — the app can
  sort a level three ways and this does not read that setting.
- **Archived thoughts are not searched or listed**, matching what you see in the app. One is still
  readable if the agent already has its id, and every tool that returns one labels it `archived`.
- **`get_level` pages (50 at a time) and `compile_subtree` truncates.** Both say so in the result
  rather than silently, so a partial answer is never read as a complete one.
- **Listings shorten each thought's detail** (search, levels, tasks) and mark the ones they
  shortened. `get_thought` and `compile_subtree` always give you the whole of it.
- **Search matches words, not meaning.** It forgives a misspelling of a long word but will not
  find a synonym — if you know roughly where something lives, walking from `get_root` beats
  guessing words.
- **A write that collides is reported, never retried.** If your phone or the app wrote while the
  agent was working, nothing is saved and the agent is told to read again.
- Deleting a thought deletes everything inside it. It lands in the bin, restorable.

## Private fields

A thought's detail can hold a **covered** field — sealed with a key derived from your sync
passphrase, which this process does not have and cannot get. No agent reads one, at any setting,
on any transport. `get_thought` reports that covered fields *exist* without their contents, and
when an agent updates that thought they are **put back exactly where they were** — see
`preserveSealed` in `src/model/tree.ts` and its use in `src/core/mutations.ts`. An agent that
cannot see a secret must not be able to delete it either, and that was a real bug in this design
before it was built.

It also cannot **forge** one: an agent writing text shaped like a covered field has it dropped
rather than saved (`dropSealed`, same file), so no agent can plant a secret its owner can never
open.

## Build from source

Build it from the Tinhead repository, not from the npm tarball:

```bash
git clone <the Tinhead repository> && cd Tinhead
npm install
npm install --prefix packages/tinhead-mcp
npm run typecheck:mcp
npm --prefix packages/tinhead-mcp run build
```

**What the published tarball contains, precisely:** this package's own eleven `src/*.ts` files,
this README, the LICENSE, and `dist/` — which holds compiled JavaScript for this package *and* for
the Tinhead app modules it imports (crypto, thought model, wire format, grant protocol, compile
targets). What it does **not** carry is the TYPESCRIPT of those app modules, which is what you
would actually want to read; an earlier version of this section claimed it did, and `files` cannot
reach outside a package directory, so it never could. Building from an extracted tarball does not
work either, for the same reason.

The audit surface is therefore the Tinhead repository: read those modules at the git tag matching
this package's version, where they sit beside the tests that exercise them. Vendoring a rewritten
copy into the tarball was the alternative and it is worse — a second copy of the crypto to keep
honest, and a rewrite you would have to trust before you could check anything.

## Tests

The suite lives in the Tinhead repository, because it runs the door against a **real app engine
over a shared server**: a device enables sync and writes thoughts the ordinary way, and the door
connects with a code and reads them back, writes to them, and is refused where it should be. It
also runs the whole surface through a real MCP client over the protocol, and checks what this
tool's state directory is allowed to contain — no secret in a filename, whatever you paste.

```bash
npx jest packages/tinhead-mcp        # the door, the state directory, the seals
npm run test:mcp                     # the real-MCP-client pass, after the install above
```

Two commands and not one: the protocol suite is the only thing here that needs
`@modelcontextprotocol/sdk`, which is a dependency of this package and not of the app, so the root
config skips it deliberately rather than failing a fresh clone with `MODULE_NOT_FOUND`.

## License

MIT — see [LICENSE](./LICENSE).
