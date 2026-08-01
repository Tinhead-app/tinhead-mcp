# Contributing

**This repository is generated, so please open an issue rather than a pull request.**

The tree here is produced from the private Tinhead repository at each release: it carries
exactly the source that compiled into the published npm package, rather than a re-typed copy.
That is what lets npm provenance attest the tarball against this commit — and it means a pull
request merged here would be overwritten by the next release.

We would much rather tell you that now than after you have spent an evening on a patch.

## What helps most

1. **A false claim.** This package says your key never reaches our server in a usable form. If
   that is wrong, say so — it is the most valuable issue you can open.
2. **A bug**, with what you ran and what happened.
3. **A patch in an issue.** Paste the diff; it gets applied upstream and ships in the next
   release, and you are credited in the release notes.

## Checking it yourself

```bash
npm ci
npm run build   # compiles the server from this source
npm test        # the suites that pin the grant protocol, the matcher and the keychain
```

Security findings are welcome in the open. A private disclosure of a flaw in code anyone can
already read protects nobody.
