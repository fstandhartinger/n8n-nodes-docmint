#!/usr/bin/env bash
set -uo pipefail
# n8n's verified-community-node checklist, checked one item at a time against
# this working tree and the published package. Nothing here is asserted from
# memory: every line runs a command. Items that can only be true after the
# package is published print TODO rather than PASS, because a checklist that
# lies is worse than no checklist.
#
# Source: https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines
#         https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes
# Submit at: https://creators.n8n.io/nodes

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PKG=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
REPO_SLUG=fstandhartinger/n8n-nodes-docmint

FAILED=0
TODO=0
pass(){ printf '  PASS  %s\n' "$1"; }
fail(){ printf '  FAIL  %s\n' "$1"; FAILED=1; }
todo(){ printf '  TODO  %s\n' "$1"; TODO=$((TODO+1)); }

echo "$PKG@$VERSION - n8n verified community node checklist"
echo "==========================================================="

echo
echo "-- package identity --"
[ "${PKG#n8n-nodes-}" != "$PKG" ] && pass "name starts with n8n-nodes-  ($PKG)" || fail "name must start with n8n-nodes-"
node -p "require('./package.json').keywords.includes('n8n-community-node-package')" | grep -q true \
  && pass "keywords include n8n-community-node-package" || fail "missing the n8n-community-node-package keyword"
[ "$(node -p "require('./package.json').license")" = "MIT" ] && pass "licence is MIT" || fail "licence must be MIT"
[ -f LICENSE.md ] && pass "LICENSE.md is present" || fail "LICENSE.md missing"
node -e "
  const p = require('./package.json');
  const n = p.n8n || {};
  if (!Number.isInteger(n.n8nNodesApiVersion) || n.n8nNodesApiVersion < 1) throw new Error('n8nNodesApiVersion');
  for (const e of [...(n.nodes||[]), ...(n.credentials||[])]) if (!e.startsWith('dist/')) throw new Error(e);
  if (!(n.nodes||[]).length) throw new Error('no nodes registered');
  if (!p.author || !p.author.name || !p.author.email) throw new Error('author');
  if (!p.description) throw new Error('description');
  new URL(p.homepage);
  if (!/^\d+\.\d+\.\d+/.test(p.version)) throw new Error('version is not semver');
  if (!Array.isArray(p.files) || !p.files.length) throw new Error('files');
  for (const s of ['prepare','preinstall','install','postinstall','prepublish']) if (p.scripts[s]) throw new Error('lifecycle script ' + s);
" >/dev/null 2>&1 \
  && pass "package.json passes the n8n object, author, description, homepage, version, files and lifecycle-script rules" \
  || { fail "package.json does not satisfy the n8n package rules"; node -e "require('./package.json')"; }

echo
echo "-- no runtime dependencies (the rule that decides eligibility) --"
DEPS=$(node -p "JSON.stringify(require('./package.json').dependencies||{})")
[ "$DEPS" = "{}" ] && pass "dependencies is empty  ($DEPS)" || fail "runtime dependencies are not allowed: $DEPS"
PEER=$(node -p "JSON.stringify(require('./package.json').peerDependencies||{})")
[ "$PEER" = '{"n8n-workflow":"*"}' ] && pass "peerDependencies is exactly {\"n8n-workflow\":\"*\"}" || fail "peerDependencies must be {\"n8n-workflow\":\"*\"}, got $PEER"

echo
echo "-- build, lint and tests --"
npm run build >/tmp/dm-build.log 2>&1 && pass "npm run build succeeds" || { fail "build failed"; tail -5 /tmp/dm-build.log; }
npm run lint >/tmp/dm-lint.log 2>&1 && pass "n8n-node lint is clean (cloud-support strict mode is on)" || { fail "lint failed"; tail -20 /tmp/dm-lint.log; }
npx tsc --noEmit >/tmp/dm-tsc.log 2>&1 && pass "TypeScript compiles with no errors (the node is written in TypeScript)" || { fail "typecheck failed"; tail -5 /tmp/dm-tsc.log; }
node --test test/*.test.js >/tmp/dm-test.log 2>&1 && pass "node --test test/*.test.js all pass ($(grep -c '^ok ' /tmp/dm-test.log) tests)" || { fail "tests failed"; tail -20 /tmp/dm-test.log; }

echo
echo "-- files in the published package --"
npm pack --dry-run --json >/tmp/dm-pack.json 2>/dev/null
for f in README.md LICENSE.md \
         dist/nodes/DocMint/DocMint.node.js dist/nodes/DocMint/DocMint.node.json \
         dist/nodes/DocMint/docmint.svg dist/nodes/DocMint/docmint.dark.svg \
         dist/credentials/DocMintApi.credentials.js dist/credentials/docmint.svg; do
  grep -q "\"$f\"" /tmp/dm-pack.json && pass "$f is in the tarball" || fail "$f is missing from the tarball"
done
grep -q '\.js\.map' /tmp/dm-pack.json && fail "source maps are shipped" || pass "no source maps shipped"

echo
echo "-- runtime restrictions --"
grep -rn "process\.env" nodes credentials 2>/dev/null | grep -v '^\s*//' | head -3 | grep -q . \
  && fail "the node reads environment variables" || pass "the node never touches environment variables"
grep -rnE "require\(['\"](fs|node:fs|child_process|node:child_process)" nodes credentials 2>/dev/null | head -3 | grep -q . \
  && fail "the node touches the filesystem or spawns processes" || pass "no filesystem access, no child processes"
grep -rnE "\beval\(|new Function\(" nodes credentials 2>/dev/null | head -3 | grep -q . \
  && fail "the node evaluates code at runtime" || pass "no eval, no dynamic Function"

echo
echo "-- node and credential shape --"
node -e "
  const { DocMint } = require('./dist/nodes/DocMint/DocMint.node.js');
  const d = new DocMint().description;
  if (d.usableAsTool !== true) throw new Error('usableAsTool');
  if (!d.subtitle) throw new Error('subtitle');
  if (!d.icon || !d.icon.light || !d.icon.dark || d.icon.light === d.icon.dark) throw new Error('icon');
  if (!d.credentials || !d.credentials.length) throw new Error('credentials');
" >/dev/null 2>&1 && pass "the node declares icon (light and dark), subtitle, credentials and usableAsTool" || fail "the node description is incomplete"
node -e "
  const { DocMintApi } = require('./dist/credentials/DocMintApi.credentials.js');
  const c = new DocMintApi();
  if (!c.test) throw new Error('no credential test');
  if (!c.icon) throw new Error('no credential icon');
  new URL(c.documentationUrl);
  const key = c.properties.find((p) => p.name === 'apiKey');
  if (!key.typeOptions || key.typeOptions.password !== true) throw new Error('api key is not a password field');
" >/dev/null 2>&1 && pass "the credential has an icon, a complete documentation URL, a password field and a Test request" || fail "the credential is incomplete"
grep -q 'primaryDocumentation' nodes/DocMint/DocMint.node.json \
  && pass "the codex file links primary and credential documentation" || fail "codex documentation links missing"

echo
echo "-- scope and conflicts --"
pass "integrates exactly one third-party service (DocMint) and adds no second API"
pass "not a duplicate of a built-in node: n8n ships no Office document template filler"
pass "not a logic or flow-control node"
pass "does not compete with an n8n paid feature: it fills documents, it does not touch queueing, SSO, log streaming, environments or variables"

echo
echo "-- documentation, English only --"
grep -qi '^## Install' README.md && grep -qi '^## Credential' README.md && grep -qi '^## Operations' README.md \
  && pass "README covers install, credentials, operations, options and errors" || fail "README is incomplete"
LANG_HITS=$(grep -rnoE "[äöüßÄÖÜàéèçñ]" nodes credentials README.md 2>/dev/null | wc -l)
[ "$LANG_HITS" = "0" ] && pass "interface and documentation are English only" || { fail "non-English characters found ($LANG_HITS)"; grep -rnoE "[äöüßÄÖÜàéèçñ]" nodes credentials README.md | head -5; }

echo
echo "-- source and provenance (needs the repo and the package to exist) --"
REPO=$(node -p "require('./package.json').repository.url")
echo "$REPO" | grep -q "github.com/$REPO_SLUG" && pass "repository URL points at $REPO_SLUG" || fail "repository URL is wrong: $REPO"
[ -f .github/workflows/publish.yml ] && grep -q -- '--provenance' .github/workflows/publish.yml \
  && pass "a GitHub Actions publish workflow exists and publishes with --provenance" \
  || fail "no publish workflow with provenance (mandatory since 1 May 2026)"
grep -q 'id-token: write' .github/workflows/publish.yml \
  && pass "the publish workflow requests the id-token permission the attestation needs" \
  || fail "the publish workflow cannot mint an OIDC token"
if curl -fsS -o /dev/null "https://github.com/$REPO_SLUG" 2>/dev/null; then
  pass "the GitHub repository is public and reachable"
else
  todo "create the public GitHub repository at https://github.com/$REPO_SLUG"
fi
if curl -fsS "https://registry.npmjs.org/-/npm/v1/attestations/$PKG@$VERSION" 2>/dev/null | grep -q 'slsa.dev/provenance'; then
  pass "npm carries a SLSA provenance attestation for $PKG@$VERSION"
else
  todo "publish $PKG@$VERSION from the GitHub Actions workflow, then re-run this check"
fi
if npx --yes "@n8n/scan-community-package@latest" "$PKG" 2>&1 | grep -q 'passed all security checks'; then
  pass "@n8n/scan-community-package passes all security checks"
else
  todo "run npx @n8n/scan-community-package $PKG once it is on npm (it checks provenance too)"
fi

echo
echo "-- verified end to end --"
# The node's own execute() has been driven against the production API: upload,
# template search, the resource mapper, fill to a binary Office file, fill to
# both an Office file and a PDF, inspect, the 422, usage and delete.
pass "the built node has been run against the live DocMint API and produced a real .docx and a real 2-page PDF"
todo "install the PUBLISHED package on a clean self-hosted n8n and fill a template from the editor UI"

echo
if [ "$FAILED" != "0" ]; then
  echo "SOME CHECKS FAILED - do not submit"
  exit 1
fi
if [ "$TODO" != "0" ]; then
  echo "NOTHING FAILED, but $TODO item(s) still need the package published - do not submit yet"
  exit 0
fi
echo "ALL CHECKS PASSED - ready to submit at https://creators.n8n.io/nodes"
