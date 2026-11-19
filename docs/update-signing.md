# Setting up signed updates (one time)

From 0.5.6 the computer app can install a new version from inside the app. Before it installs a
file, it checks the file's signature. The build service makes the signatures with a private key
that only the owner holds; the app checks them with the matching public key, which is in
`src-tauri/tauri.conf.json`. A file that was not signed with that key is refused.

Until both halves are set up, the build still works, but its installers are not signed and the
app falls back to downloading new versions in the browser.

**Current state (2026-11-19):** the key pair was made, the public key is in `tauri.conf.json`, and
the owner keeps the private key and its password outside the repository. They reach the build
service only as the two GitHub secrets in step 3. Steps 1 and 4 below are only needed to replace
the key.

## 1. Make the key pair

On your own computer, with Node.js installed (the LTS version from nodejs.org), open a terminal
(PowerShell on Windows) and run:

```
npx @tauri-apps/cli@2.12.4 signer generate -w scalenote-updates.key
```

It asks for a password twice. Pick a strong one and keep it with the key. It writes two files in
the folder the terminal is in:

- `scalenote-updates.key`: the **private key**. Never share it, never put it in the repository,
  and never put it in your notes folder (it would sync to your other devices).
- `scalenote-updates.key.pub`: the **public key**. Safe to share.

## 2. Keep the private key safe

Store `scalenote-updates.key` and its password in two safe places, for example a password manager
and a USB stick. If both are lost, no update can ever be signed for the copies already
installed, and everyone has to download the next version by hand once.

## 3. Give the build service the private key

On GitHub, open the repository, then **Settings**, **Secrets and variables**, **Actions**, and add
two repository secrets with **New repository secret**:

| Name | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the whole text inside `scalenote-updates.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password from step 1 |

GitHub never shows a secret again after it is saved, and it is not visible in build logs.

## 4. Put the public key in the app

The text inside `scalenote-updates.key.pub` goes into `src-tauri/tauri.conf.json`, under
`plugins`, `updater`, `pubkey`, in a pull request. You can also hand the text to whoever builds the
next version.

## 5. Check

After the next tagged release, the release has a file called `latest.json` next to the installers.
The build log of the "Build the app" step no longer warns that the signing key is not set up.

## How it fits together

- `src-tauri/src/selfupdate.rs`: finds out how this copy was installed and installs the update.
- `scripts/latest-json.mjs`: writes `latest.json` for each release.
- `.github/workflows/build.yml`: signs the installers and uploads `latest.json`.
