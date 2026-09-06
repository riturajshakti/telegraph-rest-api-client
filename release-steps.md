# Release steps

How to publish **Telegraph REST API Client** to the VS Code Marketplace.

- Publisher ID: `riturajshakti`
- Extension ID: `riturajshakti.telegraph-rest-api-client`
- Repository: <https://github.com/riturajshakti/telegraph-rest-api-client>

Two parts: [first-time setup](#part-1--first-time-setup) (once) and
[publishing a release](#part-2--publishing-a-release) (every time).

---

## Part 1 — First-time setup

Only needed once per machine.

### 1. Create an Azure DevOps organisation

The Marketplace authenticates through Azure DevOps, not GitHub.

1. Go to <https://dev.azure.com> and sign in with a Microsoft account
2. Create an organisation if you do not have one — the name does not matter

### 2. Create a Personal Access Token

1. Go to <https://dev.azure.com/riturajshakti/_usersSettings/tokens>
   (or: user settings icon, top right → **Personal access tokens**)
2. **+ New Token**, then set:
   - **Name:** `vsce-telegraph`
   - **Organization:** `riturajshakti` — your own organisation
   - **Expiration:** up to 1 year
   - **Scopes:** **Custom defined**, then **Show all scopes** and tick
     **Marketplace → Manage**
3. **Create**, and copy the token immediately — it is shown only once

> **Do not choose "All accessible organizations".** Those are *global* PATs, and
> Microsoft is
> [retiring them](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/)
> — all existing global tokens stop working on **December 1, 2026**. A token
> scoped to your own organisation is what publishing needs and is not affected.

**Scopes are the usual failure point.** **Marketplace → Manage** only appears
after clicking **Show all scopes**; the initial list does not include it. A
token without it packages fine but fails at publish with a `401`.

Store it in a password manager. It is the only credential that can publish
under your name.

### 3. Create the publisher

**Do this before logging in.** `vsce login` verifies the token *against the
publisher*, so it fails if the publisher does not exist yet.

1. Go to <https://marketplace.visualstudio.com/manage>
2. Sign in with the **same Microsoft account** that created the token
3. **Create publisher**, and set the **ID** to exactly `riturajshakti`

The ID must match the `publisher` field in `package.json`. It cannot be changed
later, and the name is permanent once anything is published under it. The
display name is free text and can be changed.

### 4. Log in locally

```sh
npx @vscode/vsce login riturajshakti
```

Paste the token when prompted. It is stored in your OS keychain, so this is not
needed again until the token expires.

---

## Part 2 — Publishing a release

Run these from the project root for every release, first or otherwise.

### 1. Verify the build is clean

```sh
npx tsc --noEmit          # no type errors
node build.mjs            # rebuild dist/
```

Both must succeed. `dist/` is shipped but not committed, so a stale build would
publish old code.

### 2. Run the tests

```sh
cd server && npm test && cd ..
```

Expect **95/95 passed**. The server is dev-only and never ships, but the tests
exercise the request engine end to end.

### 3. Update the version

> **Skip this step on the very first publish.** The version in `package.json`
> has never been published, so it is already correct — bumping it would just
> skip a version number.

For every release after the first, bump before publishing. The Marketplace
refuses a version that already exists.

| Change | Bump | Example |
|---|---|---|
| Bug fixes only | patch | `0.1.0` → `0.1.1` |
| New features, backwards compatible | minor | `0.1.1` → `0.2.0` |
| Breaking changes | major | `0.2.0` → `1.0.0` |

```sh
npm version patch --no-git-tag-version    # or minor / major
```

This edits `package.json` only. The tag is created in step 6.

### 4. Update the changelog

Add a section to `CHANGELOG.md` for the new version, above the previous one:

```markdown
## [0.1.1] — 2026-09-10

### Fixed

- Raw tab now shows the real base64 `Authorization` header
```

Users read this on the Marketplace **Changelog** tab. Describe the effect on
the user, not the internal change.

### 5. Inspect the package before publishing

```sh
npx @vscode/vsce ls --no-dependencies
```

Expect exactly these 14 files:

```
package.json  README.md  LICENSE.txt  CHANGELOG.md
media/telegraph.svg  media/tab-request.svg  media/tab-env.svg  media/icon.png
dist/webview.js  dist/webview.css  dist/sidebar.js
dist/read-file-worker.js  dist/extension.js  dist/env.js
```

If anything else appears, add it to `.vscodeignore` before continuing. `src/`,
`server/`, `images/`, `node_modules/`, and lockfiles are all excluded already.

Then build the file and check its size:

```sh
npx @vscode/vsce package --no-dependencies
```

Should be roughly **75 KB**. A sudden jump means something got included that
should not have been.

### 6. Commit, tag, and push

Push **before** publishing. The Marketplace renders `README.md` from the
`main` branch, so images 404 on the listing if the commit is not up there yet.

```sh
git add -A
git commit -m "Release 0.1.1"
git tag v0.1.1
git push origin main --tags
```

### 7. Publish

```sh
npx @vscode/vsce publish --no-dependencies
```

The listing appears at
<https://marketplace.visualstudio.com/items?itemName=riturajshakti.telegraph-rest-api-client>
within a few minutes. A first publish can take up to 15 minutes to become
searchable.

### 8. Verify

1. Open the Marketplace page and check that all 15 screenshots load
2. In VS Code: **Extensions** → search `Telegraph REST API Client` → install
3. Send one request to confirm the packaged build works

Installing your own published build catches problems no local test can — a
missing `dist/` file, or an asset excluded by mistake.

### 9. Create a GitHub release (optional)

```sh
gh release create v0.1.1 \
  --title "v0.1.1" \
  --notes "See CHANGELOG.md" \
  telegraph-rest-api-client-0.1.1.vsix
```

Gives people a way to install a specific version by hand, and a place to link
from issues.

---

## Quick reference

**First publish** — no version bump, `package.json` is already at `0.1.0`:

```sh
npx tsc --noEmit && node build.mjs
cd server && npm test && cd ..
npx @vscode/vsce ls --no-dependencies
git add -A && git commit -m "Release 0.1.0" && git tag v0.1.0
git push origin main --tags
npx @vscode/vsce publish --no-dependencies
```

**Every release after that** — bump first:

```sh
npx tsc --noEmit && node build.mjs
cd server && npm test && cd ..
npm version patch --no-git-tag-version
# edit CHANGELOG.md
npx @vscode/vsce ls --no-dependencies
git add -A && git commit -m "Release 0.1.1" && git tag v0.1.1
git push origin main --tags
npx @vscode/vsce publish --no-dependencies
```

---

## Troubleshooting

**`ERROR Missing publisher name`**
`package.json` has no `publisher` field, or it does not match your Marketplace
publisher ID. It must be exactly `riturajshakti`.

**`ERROR Failed request: (401)`**
The token expired, or it is missing the **Marketplace → Manage** scope (which
is hidden until you click **Show all scopes**). Create a new token scoped to
the `riturajshakti` organisation with that scope, then run
`npx @vscode/vsce login riturajshakti` again.

Tokens also expire — a year on, publishing starts failing this way with no
other symptom. Creating a fresh one is the fix.

**`Access Denied: ... needs the following permission(s) on the resource /riturajshakti`**
The publisher does not exist yet, or it belongs to a different Microsoft
account than the one that created the token. Create it at
<https://marketplace.visualstudio.com/manage> with the ID exactly
`riturajshakti`, signed in as the same account, then run `vsce login` again.
The existing token is fine — this is not a scope problem.

**`ERROR Version 0.1.0 already exists`**
That version was published before. Bump and try again — a published version can
never be reused, even after unpublishing.

**Images are broken on the Marketplace listing**
The README uses absolute `raw.githubusercontent.com` URLs, which only resolve
once the commit is on `main` and the repository is public. Check one directly:

```sh
curl -o /dev/null -w "%{http_code}\n" \
  https://raw.githubusercontent.com/riturajshakti/telegraph-rest-api-client/main/images/api-request.png
```

`200` means it will render; `404` means push first. The Marketplace caches
images, so a fixed URL can take a while to appear.

**The published extension behaves like an older version**
`dist/` is generated and git-ignored, so it is only as fresh as your last
`node build.mjs`. Rebuild and republish with a new patch version.

**Unpublishing**

```sh
npx @vscode/vsce unpublish riturajshakti.telegraph-rest-api-client
```

Removes the extension for everyone and frees nothing — the version numbers stay
used. Prefer publishing a fix over unpublishing.
