# tinhead-mcp — source

The published source of [`tinhead-mcp`](https://www.npmjs.com/package/tinhead-mcp) v0.1.0,
the local MCP server that gives an agent access to branches of your Tinhead tree.

**Why this repository exists.** The Tinhead app is closed source. This package is not, because
it is the part that holds your key: it unwraps your account key on your own machine, talks to
Tinhead's server, and enforces the branch you granted. Every claim the package makes about
what leaves your machine is either true in this code or false in it.

> ### This tree is generated — please open an issue, not a pull request
>
> It is produced from the private Tinhead repository at each release, so it carries exactly the
> source that compiled into the published package rather than a re-typed copy. **A pull request
> here cannot be merged in any lasting way — the next release would overwrite it.**
>
> That is not a brush-off, and we would rather say it plainly than let you find out after an
> evening on a patch. Open an issue with the fix or the finding; it gets applied upstream and
> ships in the next release, and you are credited in the release notes. If a claim in this code
> is false, that is the single most valuable thing you can tell us.

## What is here

| | |
|---|---|
| `packages/tinhead-mcp/` | the server itself — the grant protocol, the tools, the keychain |
| `src/crypto/` | the primitives. **This is the claim** — key wrapping, node encryption |
| `src/agent/` | both sides of the grant protocol: what is sent, what never is |
| `src/model/` | the thought format and its lenses, including the private-field seal |
| `src/sync/payload.ts` | the wire format — observable on the network anyway |
| `src/compile/`, `src/presets/`, `src/core/` | what the read tools emit, and the write rules |

## What is not here, deliberately

The app: its interface, motion, theme, store, screens, and the sync **engine**. None of it
can affect the claims above, and it is the product rather than the format.

## Build it yourself

```bash
npm ci --prefix packages/tinhead-mcp
npm run build --prefix packages/tinhead-mcp
```

That installs at the ROOT deliberately: the modules under `src/` resolve their dependencies by
walking up from themselves, so they can only ever find a `node_modules` here. The generator
derives its file list from the package's own `tsconfig.json`, so a module the server imports
cannot be missing from this repository and still build.

## Reporting something

Issues: https://github.com/Tinhead-app/tinhead-mcp/issues

Security findings are welcome in the open — this package exists to be checked, and a private
disclosure of a flaw in code anyone can already read helps nobody.

## Licence

Apache-2.0. See `LICENSE` and `NOTICE` **at the root of this repository** — they cover the
whole published tree, `src/` included, not just the package directory.