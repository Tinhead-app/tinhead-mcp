#!/usr/bin/env node
/**
 * Refuse to publish `tinhead-mcp` while its own README is lying.
 *
 * This package's pitch is a cryptographic claim — *the server holds a key it
 * cannot use* — and the README backs it with a promise: **"if any claim below is
 * false, it is false in the Tinhead repository, in code you can read."** That
 * promise is only worth anything if there is a repository, and if npm shows a
 * link to it.
 *
 * SPEC-AGENT §4's history is why this is a gate and not a note: v0.1 sent
 * `grantWrap` on every connect while asserting it never did, and a source-level
 * review is what caught it. A published package whose source nobody can read is
 * the same failure with nobody in the room.
 *
 * So: metadata that makes the claim reachable, a build that actually exists, and
 * a bin that runs. Any of them missing and `npm publish` stops here.
 *
 * Run by `prepublishOnly`, and directly (`node scripts/prepublish-check.mjs`) to
 * see what is still owed.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const pkg = JSON.parse(read('package.json'));
const problems = [];
const fail = (what, why) => problems.push({ what, why });

// ---- the metadata npm turns into a link, and a reader turns into trust ----

const repoUrl =
  typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? null;
if (!repoUrl) {
  fail(
    'package.json has no "repository"',
    'npm renders no source link without it, so the README\'s "in code you can read" points\n' +
      '     nowhere. This is the field the whole open-source claim hangs on.'
  );
} else if (!/^(https:\/\/|git\+https:\/\/)/.test(repoUrl)) {
  fail(`"repository" is not a public https URL (${repoUrl})`, 'a reader must be able to open it.');
}
if (!pkg.author) fail('package.json has no "author"', 'an unattributed security package reads as abandoned.');
if (!pkg.bugs) fail('package.json has no "bugs"', 'no route to report a flaw is its own kind of claim.');

// ---- the LICENSE names a legal person, not a product ----

// The holder must AGREE with `author`, rather than match a name this script
// picks. An earlier version hard-refused the string "Tinhead" on the reasoning
// that a product cannot hold a copyright — true, but it is the founder's call
// and not a script's, and the notice text does not determine ownership anyway
// (it vests in the author and moves to a company by written assignment).
// What a script CAN usefully catch is the two fields disagreeing, which is what
// happens when one of them is updated at incorporation and the other is not.
if (!existsSync(join(root, 'LICENSE'))) {
  fail('no LICENSE file', `the package.json says ${pkg.license}; ship the text that says so.`);
} else {
  const licenseText = read('LICENSE');
  // Both spellings: MIT-style `Copyright (c) 2026 Name`, and the Apache
  // appendix's `Copyright 2026 Name` (no `(c)`), which is what `LICENSE-2.0.txt`
  // carries once its `[yyyy] [name of copyright owner]` template is filled in.
  const holder = licenseText.match(/^\s*Copyright (?:\(c\) )?\d{4} (.+)$/m)?.[1]?.trim();
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  if (!holder || /name of copyright owner/.test(licenseText)) {
    fail(
      'LICENSE has no filled-in copyright line',
      'the Apache appendix ships as a `[yyyy] [name of copyright owner]` TEMPLATE — a licence\n' +
        '     left on its placeholder names no holder and grants nothing clearly.'
    );
  } else if (author && !holder.toLowerCase().includes(String(author).toLowerCase().split('<')[0].trim())) {
    fail(
      `LICENSE holder ("${holder}") and package.json author ("${author}") disagree`,
      'one of them was updated and the other was not — most likely at incorporation.'
    );
  }
  // Apache-2.0 asks for a NOTICE alongside, and reviewers look for it.
  if (pkg.license === 'Apache-2.0' && !existsSync(join(root, 'NOTICE'))) {
    fail('Apache-2.0 with no NOTICE file', 'ship the attribution the licence expects to travel with it.');
  }
}

// ---- the tarball must contain something that runs ----

const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0];
if (!bin) fail('package.json declares no "bin"', 'the setup instructions are all `npx tinhead-mcp`.');
else if (!existsSync(join(root, bin))) {
  fail(`the bin does not exist: ${bin}`, 'run `npm run build` — publishing an unbuilt package ships a 404 with extra steps.');
}

// ---- the README must not promise what the metadata cannot deliver ----

const readme = read('README.md');
if (/\bis open source\b/i.test(readme) && !repoUrl) {
  fail(
    'README claims the package is open source',
    'and there is no repository to be open in. Either publish the source first, or soften\n' +
      '     the claim — do not ship the sentence ahead of the thing.'
  );
}
if (/npx tinhead-mcp/.test(readme) && !pkg.name.startsWith('tinhead-mcp')) {
  fail('README tells people to run a package name this is not', `package name is "${pkg.name}".`);
}

// ---- say everything at once; a checklist revealed one line at a time is a bad day ----

if (problems.length) {
  console.error(`\ntinhead-mcp is not ready to publish — ${problems.length} thing(s) owed:\n`);
  for (const [i, p] of problems.entries()) {
    console.error(`  ${i + 1}. ${p.what}\n     ${p.why}\n`);
  }
  console.error('See SPEC-AGENT §10 for what publishing is supposed to buy, and why.\n');
  process.exitCode = 1;
} else {
  console.log('tinhead-mcp: publish checks passed.');
}
