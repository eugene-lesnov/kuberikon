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
For offline installation, download both files into the same folder and run the
following commands, replacing `VERSION` with the downloaded release version:

```sh
sha256sum --check --ignore-missing SHA256SUMS
npm install --global --offline --ignore-scripts ./kuberikon-VERSION.tgz
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

1. Press **F2** to choose a profile. **Cluster (1)** opens on Services;
   **s** / **p** switches Services / Pods, and **F4** chooses a namespace.
   Use `*` for all namespaces.
2. Select a resource and press **f** to forward a port. If it has several ports,
   choose the remote port first. Confirm the suggested free local port with
   **Start forward**. Kuberikon remembers the mapping. When a
   resource has one saved forward, **f** starts or stops it. With several saved
   forwards, choose the mapping by address and action.
3. **Enter** opens the resource card. Each row shows a remote port and, for a
   saved forward, its local address and state. Select a row and press **Enter**
   to set up, start, retry or stop that forward. To give the same port another
   local address, select its saved mapping and choose **Add local port…** (**n**).
   You can also copy the address, open HTTP/HTTPS in your browser, or view logs.
4. **Port Forwards (3)** shows connections across profiles, including stopped
   ones. Press **f** to connect or stop, **e** to edit, **d** to delete remembered
   settings, **c** to copy the address, or **o** to open HTTP/HTTPS. **h** limits
   the list to active and failed connections.

Press **u** on a Service to pin it in **Favorites (2)**. Use **[** / **]** to
reorder favorites. **Enter** opens the same resource card there.
Press **l** on a resource or connection to open logs;
a running forward is not required. Favorites and Cluster have the same **f**
action. On a Pod it controls forwards to that Pod. Press **m** on a Pod to open
a matching Service's card; if several match, choose one from the list.
Logs show original lines with automatic level highlighting. Press **Enter** to
read a record with expanded JSON/logfmt fields. Search, filtering and export are
available without configuring a format.

Use **Templates (4)** to start or stop a group of forwards with **f**.
Press **n** to create a template, or **t** on a saved forward to add it to one.
Use **[** / **]** to reorder templates. Template autostart is off by default.
When enabled, it runs once with the profile selected at startup, including a
profile chosen during initial setup. Switching profiles later does not trigger
autostart.

Favorites and templates use the selected profile. Starting a template creates
or reuses connections belonging to that profile. Each connection remembers its
profile, and switching profiles leaves existing connections running. Editing
or deleting a profile stops its connections. Quitting stops all connections.

| Key | Action |
| --- | --- |
| `1`–`4` | Switch tabs |
| Arrow keys | Move focus between controls in the indicated direction |
| `Tab` / `Shift+Tab` | Alternative next/previous focus navigation |
| Up / Down | Select rows or scroll text; at the first/last item continue to the adjacent control |
| `PgUp` / `PgDn`, `Home` / `End` | Page through the focused list or text, or jump to its start/end |
| Left / Right | Move between controls; in an input, move the cursor and leave the field at its boundary |
| Typing in a focused field | Edit immediately; `Enter` moves to the next field/control |
| `Enter` / `i` | Open a resource card in Cluster or Favorites; details in Port Forwards, Templates or logs |
| `/` / `Ctrl+F` | Search |
| `r` | Refresh a resource list or reload log history |
| `Space` / `End` in logs | Toggle following / return to the latest records |
| `v` in logs | Toggle line wrapping |
| `e` in logs | Export logs |
| `Esc` | Clear a selection or search, close a dialog, or return from logs |
| `F9` | Settings |
| `F10` | Quit |

## Connection notes

kuberikon uses `kubectl get`, `logs` and `port-forward`. It does not modify
cluster objects or kubeconfig. Tokens, token files and client certificates are
supported; `exec` and `auth-provider` credentials are not.

New forwards listen on `localhost`. Choose **Advanced…** in the forward form
to change the listen address and allow network access.
Requests through a forwarded port have the target service's
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

## License

[MIT](LICENSE). Dependency licenses are included in `THIRD_PARTY_NOTICES.txt`
inside the npm package.
