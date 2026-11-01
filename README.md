# kuberikon

A terminal app for Kubernetes port forwards and pod logs. Save forwards,
group them into templates, and pin Services in Favorites for quick access
to logs and port forwarding.

## Requirements

- Linux x86_64 with glibc >= 2.28, libstdc++, libgcc and libatomic.
- Node.js >=26.4.0 <27 and npm.
- `kubectl` in `PATH` and a kubeconfig with static credentials.
- A UTF-8 terminal, at least 80 × 24 (120 × 32 recommended).

The npm package includes the application and the native UI library. Node.js and
kubectl are installed separately; the launcher enables the required FFI support.

## Run

Install from npm and start the app:

```sh
npm install --global kuberikon
kuberikon
```

Update to the latest stable release:

```sh
npm update --global kuberikon
```

The same `.tgz` package and `SHA256SUMS` are available from
[GitHub Releases](https://github.com/eugene-lesnov/kuberikon/releases).
For offline installation, download both files and run:

```sh
sha256sum --check --ignore-missing SHA256SUMS
npm install --global --offline --ignore-scripts ./kuberikon-0.1.0.tgz
```

The release package is ready to run: installation needs no build steps or npm
dependency downloads.
Use `npm uninstall --global kuberikon` to remove the application. Updates and
removal leave user settings and kubeconfig files in place.

On first launch, choose a folder with your `.kuber` files and select a profile.
These are kubeconfig files with a `.kuber` extension; other extensions are not
accepted. Later launches restore the last profile.

You can also select a profile or folder from the command line:

```sh
kuberikon --kubeconfig /path/to/dev.kuber --namespace platform
kuberikon --profiles-dir /path/to/profiles
```

Use `--theme light` for a light terminal, `--no-autostart` to leave all forwards
stopped, and `--help` for the full list of options. `--doctor` shows local runtime
and configuration paths without connecting to a cluster.

## Usage

1. Press **F2** to choose a profile. In **Cluster (4)**, press **F4** to choose
   a namespace. Use `*` for all namespaces.
2. In **Cluster (4)**, select a Service or Pod and press **f** to create a
   forward. Set the ports and choose whether to start it after saving.
3. In **Forwards (2)**, press **s** to start or stop, **e** to edit, or **d**
   to delete. Saved forwards stay available after restarting the app.

Press **u** on a Service to pin it in **Favorites (1)**. Press **l** on a
Service, Pod or saved forward to open logs; a running forward is not required.
In **Favorites (1)**, press **f** on a Service to create a forward.
Logs show original lines with automatic level highlighting. Press **Enter** to
read a record with expanded JSON/logfmt fields. Search, filtering and export are
available without configuring a format.

Use **Templates (3)** to start or stop a group of forwards with **s**.
Press **n** to create a template, or **t** on a saved forward to add it to one.
Template autostart is off by default.

Favorites, forwards and templates use the selected profile. Switching profiles
asks before stopping active forwards; it does not start them on the new profile.

| Key | Action |
| --- | --- |
| `1`–`4` | Switch tabs |
| `Tab` / `Shift+Tab` | Move focus between controls |
| Up / Down | Select rows or scroll the focused text; stay at list boundaries |
| `PgUp` / `PgDn`, `Home` / `End` | Page through the focused list or text, or jump to its start/end |
| Left / Right | Move the input cursor or focus another button in the same group |
| Typing in a focused field | Edit immediately; `Enter` moves to the next field/control |
| `Enter` / `i` | Open details in Cluster, Forwards, Templates or logs |
| `/` / `Ctrl+F` | Search |
| `r` | Refresh a resource list or reload log history |
| `Space` / `End` in logs | Toggle following / return to the latest records |
| `v` in logs | Toggle line wrapping |
| `e` in logs | Export logs |
| `F9` | Settings |
| `F10` | Quit |

## Connection notes

kuberikon uses `kubectl get`, `logs` and `port-forward`. It does not modify
cluster objects or kubeconfig. Tokens, token files and client certificates are
supported; `exec` and `auth-provider` credentials are not.

New forwards listen on `localhost`. You can choose another address to allow
network access. Requests through a forwarded port have the target service's
permissions, so exposing a port can also expose write operations.

Run the app as your regular user. Ports below the system's unprivileged-port
threshold request sudo for a separate local helper; kubectl runs as your user.

## Settings

Settings are saved in `~/.config/kuberikon/settings.json`; UI state is in
`~/.local/state/kuberikon/state.json`. `XDG_CONFIG_HOME` and `XDG_STATE_HOME`
override these locations. Kubeconfig credentials are not copied into settings.

**F9 → Storage and recovery** shows file paths and can restore the last valid
settings backup.

## Build from source

Use Node.js 26.13.0, pinned in [.node-version](.node-version), and npm 11.21.1,
pinned in [.npm-version](.npm-version):

```sh
npm install --global "npm@$(cat .npm-version)" --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm start
```

`npm run check` checks JavaScript syntax. `npm run build` bundles the application,
copies the Linux x64 UI library and collects dependency license notices in
`dist/`. All npm dependencies are needed only for development and building.

Run `npm run package` to create `dist/kuberikon-<version>.tgz` and
`dist/SHA256SUMS`. Install this archive with npm as shown above. `npm pack` also
builds a package through the `prepare` script and writes it to the current folder.
Installing directly from the Git repository builds from source and requires the
pinned Node.js version.

## CI and releases

CI runs syntax checks, builds the npm package, verifies its checksum and installs
it offline to check the CLI for pull requests and pushes to `master`.
The `kuberikon-npm-linux-x64` Actions artifact is retained for
7 days. CI does not run application tests.

The first stable version is `0.1.0`. Follow [the release setup guide](docs/RELEASING.md)
for the one-time npm publication and Trusted Publisher configuration.
For later releases, update both manifests with
`npm version <version> --no-git-tag-version --ignore-scripts`, commit and push the
changes to the default branch, then push the matching tag. For example:

```sh
git tag -a v0.1.1 -m 'kuberikon 0.1.1'
git push origin v0.1.1
```

The Release workflow accepts stable `major.minor.patch` versions only, validates
the tag and default-branch ancestry, and builds one npm archive. It publishes this
archive to npm using OIDC, then creates the GitHub Release with `SHA256SUMS`.
When the package does not yet exist in npm, version `0.1.0` creates the GitHub
Release and reports the one-time manual npm publication in the workflow summary.
Release runs are queued and processed sequentially. Older versions cannot replace
the current `latest`; backfilled versions use the `previous` npm tag.
Release artifacts are retained for 30 days. You can also dispatch Release with
an existing version tag selected.

Uploads remain in a draft until every file is present. After a failed upload,
rerun the failed job to continue the draft with the same build artifacts;
existing files must have matching digests. An npm version already published with
the same SHA512 integrity is reused. Different contents under the same version
are rejected. Published GitHub releases are verified without overwriting files.

Public repositories also publish build provenance. Verify a downloaded file with:

```sh
gh attestation verify ./kuberikon-0.1.0.tgz -R eugene-lesnov/kuberikon
```

For private repositories on GitHub Enterprise Cloud, set the repository variable
`ENABLE_ARTIFACT_ATTESTATIONS=true` to enable provenance. Other private repositories
publish checksums without attestations. No personal access token is required.

In GitHub repository settings, require successful CI for the default branch,
restrict creation and modification of `v*` tags to release maintainers, and enable
immutable releases. npm publishing requires a Trusted Publisher for
`eugene-lesnov/kuberikon`, workflow `release.yml`, with direct `npm publish`
permission. No npm publishing token is stored in GitHub.

## License

[MIT](LICENSE). Dependency licenses are included in `THIRD_PARTY_NOTICES.txt`
inside the npm package.
