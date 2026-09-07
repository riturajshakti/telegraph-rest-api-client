# Release steps

How to publish **Telegraph REST API Client** to the two extension registries.

- Publisher / namespace: `riturajshakti`
- Extension ID: `riturajshakti.telegraph-rest-api-client`
- Repository: <https://github.com/riturajshakti/telegraph-rest-api-client>

| Registry | Reaches | Tool |
|---|---|---|
| **VS Code Marketplace** | VS Code | `vsce` |
| **Open VSX** | Cursor, Windsurf, VSCodium, Gitpod, Theia | `ovsx` |

Microsoft's Marketplace licence only permits its own products, so the forks pull
from Open VSX instead. Publishing to both is the same `.vsix` uploaded twice.

- [Part 1 — Marketplace setup](#part-1-vs-code-marketplace-first-time-setup) (once)
- [Part 2 — Open VSX setup](#part-2-open-vsx-first-time-setup) (once)
- [Part 3 — Publishing a release](#part-3-publishing-a-release) (every time)

---

## Part 1 — VS Code Marketplace first-time setup

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

## Part 2 — Open VSX first-time setup

Open VSX is run by the Eclipse Foundation, so it authenticates through an
Eclipse account rather than Azure. Only needed once.

### 1. Create an Eclipse account

1. Sign up at <https://accounts.eclipse.org/user/register>
2. Verify the email it sends

### 2. Sign the Publisher Agreement

This is the step people miss, and publishing fails without it.

1. Go to <https://accounts.eclipse.org/user/edit/eclipse-account>
2. Fill in **GitHub username** and save — Open VSX matches accounts by it
3. Go to <https://open-vsx.org>, click **Log In**, and authorise with GitHub
4. Open your profile menu → **Settings** → and sign the
   **Eclipse Foundation Open VSX Publisher Agreement**

### 3. Create an access token

1. At <https://open-vsx.org>, profile menu → **Settings** → **Access Tokens**
2. **Generate New Token**, give it a description such as `ovsx-telegraph`
3. Copy it immediately — like the Azure token, it is shown only once

Store it alongside the Azure PAT. These are two different credentials for two
different registries.

### 4. Create the namespace

The namespace must match the `publisher` field in `package.json`.

```sh
export OVSX_PAT=<your-open-vsx-token>
npx ovsx create-namespace riturajshakti -p $OVSX_PAT
```

Do this once. A namespace you create is *unverified*, which is fine — it only
means the listing does not show an ownership badge. To claim verified ownership
later, open an issue on
<https://github.com/EclipseFdn/open-vsx.org> requesting namespace verification.

### 5. Check it worked

```sh
npx ovsx verify-pat riturajshakti -p $OVSX_PAT
```

Prints a success message when the token and namespace line up.

---

## Part 3 — Publishing a release

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

### 7. Publish to both registries

Build the `.vsix` once and upload the same file to both, so the two listings
are byte-identical.

```sh
npx @vscode/vsce package --no-dependencies
```

**VS Code Marketplace:**

```sh
npx @vscode/vsce publish --no-dependencies
```

**Open VSX:**

```sh
export OVSX_PAT=<your-open-vsx-token>
npx ovsx publish telegraph-rest-api-client-0.1.1.vsix -p $OVSX_PAT
```

Passing the built `.vsix` explicitly means `ovsx` uploads exactly what you
inspected in step 5 rather than repacking.

Listings:

- <https://marketplace.visualstudio.com/items?itemName=riturajshakti.telegraph-rest-api-client>
- <https://open-vsx.org/extension/riturajshakti/telegraph-rest-api-client>

The Marketplace takes a few minutes to appear, and up to 15 on a first publish
before it is searchable. Open VSX is usually live within a minute.

If one registry succeeds and the other fails, that is fine — they are
independent. Fix the failure and re-run just that command; no version bump is
needed because the version was never accepted there.

### 8. Verify both registries

A listing page can be cached or still propagating, so check the APIs — they
report what each registry is actually serving.

**Both versions at a glance:**

```sh
VER=$(node -p "require('./package.json').version")

curl -s -X POST "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json;api-version=7.1-preview.1" \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"riturajshakti.telegraph-rest-api-client"}]}],"flags":914}' \
  | python3 -c "import json,sys; e=json.load(sys.stdin)['results'][0]['extensions'][0]; \
    s={x['statisticName']:x['value'] for x in e.get('statistics',[])}; \
    print('marketplace:', e['versions'][0]['version'], '|', int(s.get('install',0)), 'installs')"

curl -s "https://open-vsx.org/api/riturajshakti/telegraph-rest-api-client" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); \
    print('open vsx:   ', d['version'], '|', d.get('downloadCount',0), 'downloads')"
```

Both should print the version you just published. If one lags, give it a minute
— Open VSX is usually live within a minute, the Marketplace can take 15 on a
first publish.

**Confirm the packages download:**

```sh
curl -sL -o /dev/null -w "marketplace vsix: %{http_code}\n" \
  "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/riturajshakti/vsextensions/telegraph-rest-api-client/$VER/vspackage"
curl -sL -o /dev/null -w "open vsx vsix:    %{http_code}\n" \
  "https://open-vsx.org/api/riturajshakti/telegraph-rest-api-client/$VER/file/riturajshakti.telegraph-rest-api-client-$VER.vsix"
```

Two `200`s mean both are serving the package. The `-L` matters — both registries
redirect to a CDN, so without it you get a `302` that looks like a failure.

**Confirm the right bytes shipped** — catches a stale `dist/` or a wrongly
excluded asset, which no local test can:

```sh
curl -sL "https://open-vsx.org/api/riturajshakti/telegraph-rest-api-client/$VER/file/riturajshakti.telegraph-rest-api-client-$VER.vsix" -o /tmp/check.vsix
unzip -l /tmp/check.vsix | tail -20
```

Expect the same 14 files from step 5, plus the two vsce generates.

**Then install it yourself:**

1. Open both listings and check that all 15 screenshots load
2. VS Code: **Extensions** → search `Telegraph REST API Client` → install
3. A fork (Cursor, Windsurf, VSCodium) pulls from Open VSX — install there too
   if you have one, since that path is never exercised by the Marketplace
4. Send one request to confirm the packaged build works

Listings:

- <https://marketplace.visualstudio.com/items?itemName=riturajshakti.telegraph-rest-api-client>
- <https://open-vsx.org/extension/riturajshakti/telegraph-rest-api-client>

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

**First publish to a registry** — no version bump, the current version has
never been accepted there:

```sh
npx tsc --noEmit && node build.mjs
cd server && npm test && cd ..
npx @vscode/vsce ls --no-dependencies
npx @vscode/vsce package --no-dependencies
npx ovsx publish telegraph-rest-api-client-0.1.1.vsix -p $OVSX_PAT
```

The Marketplace already has `0.1.1`, so Open VSX can start from the same
version — the two registries track versions independently.

**Every release after that** — bump first:

```sh
npx tsc --noEmit && node build.mjs
cd server && npm test && cd ..
npm version patch --no-git-tag-version
# edit CHANGELOG.md
npx @vscode/vsce ls --no-dependencies
git add -A && git commit -m "Release 0.1.2" && git tag v0.1.2
git push origin main --tags

npx @vscode/vsce package --no-dependencies
npx @vscode/vsce publish --no-dependencies
npx ovsx publish telegraph-rest-api-client-0.1.2.vsix -p $OVSX_PAT
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

### Open VSX

**`Unknown namespace: riturajshakti`**
The namespace was never created. Run
`npx ovsx create-namespace riturajshakti -p $OVSX_PAT` once, then publish again.

**`Insufficient access rights for publisher: riturajshakti`**
The token belongs to a different account than the namespace owner, or the
Publisher Agreement is unsigned. Sign it at <https://open-vsx.org> under
profile → Settings, then retry — the token does not need recreating.

**`ERROR: Extension riturajshakti.telegraph-rest-api-client 0.1.1 is already published`**
That version is already on Open VSX. Bump and republish, or add
`--skip-duplicate` when you want a re-run to pass silently.

### VS Code Marketplace

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
