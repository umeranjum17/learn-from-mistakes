# Release workflow

Not a CLI journey. `../verify.mjs` must never start a pipeline, publish a package
or change npm trust policy to prove configuration, so the workflow is driven by
hand against the real registry.

## Drive

```sh
actionlint .github/workflows/release.yml          # parses, and checks the action inputs
NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
npm view "${NAME}@${VERSION}" version             # the version the merge would publish
```

Replay the publish step's guard without publishing, using the same two lines the
workflow runs:

```sh
if [ -n "$(npm view "${NAME}@${VERSION}" version 2>/dev/null)" ]; then
  echo "already on npm; nothing to publish"
else
  echo "would publish: npm publish --provenance --access public"
fi
```

A version already on npm must take the first branch; a version not on npm
(`${NAME}@99.99.99` as a stand-in) must take the second. The npm version check
`printf '%s\n%s\n' "$(npm --version)" '11.5.1' | sort -V | head -n1` must equal
`11.5.1` only for npm >= 11.5.1.

## Expected evidence

`actionlint` exits 0. The guard is proven against the real registry in both
directions. `grep -rniE 'npm[_]token|node[_]auth[_]token' .` over the repo
(excluding `node_modules`) returns nothing — the bracket in the pattern keeps this
line from matching itself — so trusted publishing is the only mechanism: no
secret, no key. A release is a version-bump PR merged to `main`; a merge without
a bump publishes nothing.

## Limitations

The publish itself is not proven here. Without npm's OIDC trusted-publisher link
for this package and repository, `npm publish` fails, so a successful publish can
only be observed after Main configures that link on npm and a version-bump PR
merges. The workflow's provenance attestation likewise needs a real publish.
Trusted consumption of the `.no-mistakes.yaml` test instructions is a separate
proof, as noted in `../SKILL.md`.