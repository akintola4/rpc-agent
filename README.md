# rpc-agent

<img src="https://raw.githubusercontent.com/akintola4/rpc-agent/main/docs/media/banner.png" width="100%" alt="rpc-agent: CLI + MCP server · device screenshots for AI agents · Claude Code, Codex, Cursor. A line drawing of a laptop, tablet and phone with a terminal in front running rpc shot; the Claude Code and Cursor marks and a terminal-prompt glyph for Codex sit beside it, with lines into the prompt.">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/akintola4/rpc-agent/main/docs/media/hero-dark.png">
  <img alt="A site captured by rpc on an iPhone 15, an iPad Air 11 and a 1440 px desktop, each framed in its device bezel" src="https://raw.githubusercontent.com/akintola4/rpc-agent/main/docs/media/hero-light.png">
</picture>

Screenshot a URL at real device viewports, optionally framed in a device
bezel, so an AI coding agent can look at the UI it just built. It's a CLI and
an MCP server in one package, with Playwright (Chromium) doing the capture.

The device catalog (49 phones, tablets, laptops and monitors) and the SVG
bezels come from the [Responsive Point Check](https://github.com/akintola4/responsive-point-check)
Chrome extension. See `NOTICE` for where the artwork comes from.

## Install

Requires Node 20.12 or newer. Run it without installing:

```sh
npx rpc-agent install          # first run: download headless Chromium (~210 MB on disk)
npx rpc-agent shot localhost:3000 -d iphone-15,desktop-1440 --bezels
```

Or install it globally to get the `rpc` command:

```sh
npm i -g rpc-agent
rpc install                    # first run: download Chromium
rpc doctor                     # checks Chromium is installed and launches
rpc shot https://example.com --bezels
```

Chromium is not downloaded when the package installs. `rpc install` (or
`npx rpc-agent install`) fetches it with rpc's own Playwright version, so
the browser always matches the one rpc launches. It installs only
Chromium's headless shell (plus Playwright's small ffmpeg), not the full
Chrome for Testing build, since captures never open a visible window
(`rpc install --headed` adds it for `rpc login`). Until you run it, every
command says Chromium is missing and prints that command, instead of
failing with Playwright's own error. Browsers go to Playwright's usual
cache, so other Playwright projects on the same version share them.

### From source

```sh
git clone https://github.com/akintola4/rpc-agent.git
cd rpc-agent
pnpm install && pnpm build
node dist/cli.js install
pnpm link --global             # optional: puts this build's `rpc` on your PATH
```

Without the link, run `node /absolute/path/to/rpc-agent/dist/cli.js` where
these docs say `rpc`, or `pnpm rpc` from inside the repo.

## CLI

![rpc run with no arguments: the banner, prompts for the URL, devices and bezels, a spinner per device, a results table and the list of files written, then the three framed screenshots](https://raw.githubusercontent.com/akintola4/rpc-agent/main/docs/media/demo.gif)

```sh
rpc                    # interactive: pick a URL, devices and options
rpc shot <url> [options]
rpc login <url> [--form]   # sign in once; later shots of that origin use the session
rpc sessions [list|clear [origin]]
rpc devices [--json]
rpc doctor [--json]    # is Chromium installed, and does it launch?
rpc install [--headed] # download Chromium with rpc's own Playwright version
rpc mcp
rpc help <command>     # options and examples for one command
```

Run `rpc` with no arguments in a terminal and it asks for the URL
(defaulting to a dev server on localhost:3000, 5173, 4321 or 8080 if one is
running), lets you tick devices from a grouped list (iPhone 15 Pro, iPad Air
11" and Desktop 1440 are preselected) and pick bezels, full page, dark mode
or reduced motion. It shows a summary, asks before capturing, and prints the
equivalent `rpc shot` command at the end so you can re-run it.

`rpc shot` in a terminal shows each device's progress, a results table and
the files it wrote:

<img alt="rpc shot in a terminal: a capture summary, one line per device with HTTP status and time, a results table, and the list of files written" src="https://raw.githubusercontent.com/akintola4/rpc-agent/main/docs/media/terminal-shot.png" width="720">

| Option | Meaning |
| --- | --- |
| `-d, --devices <ids>` | Comma-separated device ids or aliases. Default `iphone-15-pro,desktop-1440` |
| `-b, --bezels` | Also write a copy framed in the device bezel |
| `-f, --full-page` | Capture the full scroll height, however tall (up to `--max-height`) |
| `--slices` | With `--full-page`, also write viewport-tall JPEG review slices |
| `--slice-width <px>` | Maximum slice width. Default 768 |
| `--max-height <px>` | Full-page cap in CSS px. Default 60000 |
| `--reduced-motion` | Emulate `prefers-reduced-motion: reduce` |
| `-o, --out <dir>` | Output directory. Default `./.rpc-shots` |
| `--wait-for <selector>` | Wait for a visible element before capturing |
| `--wait <ms>` | Extra settle delay after load |
| `--color-scheme <s>` | `light`, `dark` or `no-preference` |
| `--timeout <ms>` | Navigation timeout. Default 30000 |
| `--no-emulate` | Viewport and DPR only: no mobile user agent or touch |
| `--json` | Print the result as JSON |
| `--open` | Open the output folder when done (`open`, `xdg-open` or `explorer`) |
| `--cookie <c>` | `name=value[; Domain=…; Path=…]`, repeatable. See [Authenticated pages](#authenticated-pages) |
| `--header <h>` | `Name: value`, repeatable, sent to the target origin only |
| `--storage-state <file>` | Load a Playwright storageState JSON |
| `--no-session` | Don't use the session saved by `rpc login` |
| `--allow-origin <o>` | Also send headers and loaded cookies to this origin, repeatable |

The URL can be a full URL, a bare local host (`localhost:3000` becomes
`http://`), a bare domain (`example.com` becomes `https://`) or a path to a
local `.html` file.

```sh
rpc shot localhost:3000 -d iphone-15,ipad,desktop-1440 --bezels
rpc shot https://example.com/pricing --full-page --slices --color-scheme dark
rpc shot localhost:5173 -d pixel --wait-for '[data-ready]' --json
```

Output files are named `<host>[-<path>]-<device>.png`, with `-framed.png`
for bezel copies and `-slice-NN.jpg` for slices, for example
`.rpc-shots/localhost-3000-iphone-15.png`. Re-running overwrites them, so the
paths stay the same between runs.

Aliases: `iphone`, `mobile`, `phone` (iphone-15-pro), `android`, `pixel`
(pixel-8), `galaxy` (galaxy-s24), `ipad`, `tablet` (ipad-air-11), `macbook`
(macbook-air-13), `laptop` (laptop-1280), `desktop` (desktop-1440), `imac`
(imac-24). Run `rpc devices` for the full list.

### What a capture does

Each device gets a fresh browser context with its CSS viewport, device pixel
ratio and, for phones and tablets, a mobile user agent plus touch. The page
loads, then rpc waits for network idle (up to 10 s, so dev servers with HMR
sockets don't hang it), web fonts and pending images. CSS animations,
transitions and Web Animations are finished before the shot.

With `--full-page`, rpc first scrolls through the page one viewport at a time
so lazy images and IntersectionObserver content load, then scrolls back to
the top. A page that fits in one Chromium capture (16,384 device px) is taken
in one pass. A taller one is taken as clipped segments of about 8,000 device
px and stitched into one PNG in Node, with no height limit apart from
`--max-height` (60,000 CSS px by default; taller pages are cut there and
marked `clipped`). Both paths render the page as if the viewport were the
whole document, so sticky headers and fixed elements appear once, at the top,
and `100vh` sections keep their real height.

Bezels frame the above-the-fold viewport. With `--bezels --full-page` you get
both: the full page raw, and the first screen framed.

### Terminal, pipes and CI

The banner, spinners, prompts and boxes only appear when stdout is an
interactive terminal. When output goes to a pipe or a file, when `CI` is
set, when `TERM=dumb`, and always with `--json`, rpc prints the same plain
lines as 0.2 (`ok …`, `x …` plus `hint:`), so agents and scripts that read
them see no change. `NO_COLOR` turns colour off; `FORCE_COLOR=1` adds colour
to the plain lines. `rpc mcp` never prints anything but MCP messages.

### When a capture fails

Each device fails on its own, with an `error`, a `code` and usually a `hint`.
In a terminal, devices that fail the same way share one hint:

<img alt="rpc shot against a host that doesn't resolve: both devices fail with ERR_NAME_NOT_RESOLVED and one hint explains what to check" src="https://raw.githubusercontent.com/akintola4/rpc-agent/main/docs/media/terminal-error.png" width="720">

Plain output (pipes, agents, CI):

```
x iphone-15 (393x852 @3x): Could not resolve host example.dev (net::ERR_NAME_NOT_RESOLVED)
   hint: Check the URL for typos. If the host works in a normal browser, this process may be
   blocked by a sandbox or network allowlist (e.g. the Claude Code sandbox: add the domain to
   the allowed hosts, or run outside the sandbox). ...
```

Covered: DNS failures, refused connections (on localhost: "nothing is
listening on port N"), proxy, tunnel and offline errors, TLS errors (https
against a plain-http dev server), missing files, redirect loops, navigation
and `--wait-for` timeouts.

## Authenticated pages

Dashboards, billing and settings pages sit behind a login. rpc can carry a
session so you don't need a hand-written "sign in, then screenshot" script.

### Sign in once with `rpc login`

```sh
rpc login localhost:3000/sign-in
rpc shot localhost:3000/app/settings/billing -d iphone-15,desktop-1440 --bezels
```

`rpc login` opens a browser window at the URL. Sign in as you normally
would (SSO and 2FA work, it's a real browser), then press Enter in the
terminal or close the window. rpc saves the browser's storage state
(cookies and localStorage) to
`~/.config/rpc-agent/sessions/<origin>.json`, for example
`http-localhost-3000.json`. From then on, `rpc shot` on that origin uses it
automatically, and the output says so:

```
auth: session http://localhost:3000 (saved 2026-10-29 22:55)
ok iphone-15 (393x852 @3x)
```

The window needs full Chromium, which `rpc install` doesn't download (it
fetches only the headless shell). Run `rpc install --headed` once, or have
Google Chrome installed; rpc falls back to it.

`--save <file>` writes the storage state to a file of your choice instead;
use it with `rpc shot --storage-state <file>`.

```sh
rpc sessions                      # origins, cookie counts, saved and expiry times
rpc sessions clear localhost:3000 # forget one origin
rpc sessions clear                # forget all
rpc shot localhost:3000/app --no-session   # capture as a signed-out visitor
```

### When the session is missing or expired

If the page redirects to a login URL (a path segment like `/login`,
`/sign-in`, `/signin` or `/auth`, different from the one you asked for),
rpc doesn't screenshot the sign-in form. The device fails with code
`AUTH_REQUIRED`:

```
x iphone-15 (393x852 @3x): Redirected to a login page (http://localhost:3000/sign-in) instead of http://localhost:3000/app/settings/billing
   hint: Session missing or expired: run `rpc login http://localhost:3000`
```

A saved session whose cookies have all passed their expiry isn't loaded,
and gives the same hint.

### CI and agents: `rpc login --form`

Without a person at the keyboard, `--form` signs in headlessly through a
standard email + password form:

```sh
export RPC_LOGIN_EMAIL=ci@example.test
export RPC_LOGIN_PASSWORD=...        # from your CI secret store
rpc login https://staging.example.com/sign-in --form
rpc shot https://staging.example.com/app/billing --json
```

It loads the page, waits for it to settle (so a client-side form has
hydrated), fills the first match of `--email-selector` (default
`input[type=email]`, then `autocomplete=username`, `name=email`,
`name=username`, `#email`) and `--password-selector` (default
`input[type=password]`), clicks `--submit-selector` (default
`button[type=submit], input[type=submit]`, or presses Enter if there is no
button), and waits for the URL to leave the login page. If it doesn't
within `--timeout`, it fails and quotes any alert the page shows ("Invalid
email or password"). `--email` works as a flag too; see the security notes
before using `--password`.

### Cookies and headers

```sh
rpc shot localhost:3000/app --cookie "session=$SESSION"
rpc shot app.example.com/admin --cookie "sid=$SID; Domain=example.com; Path=/"
rpc shot api.example.com/docs --header "Authorization: Bearer $TOKEN"
rpc shot localhost:3000/app --storage-state auth.json
```

- `--cookie` is host-only on the target unless you give a `Domain`, which
  must match the target host (or an `--allow-origin` host). `Secure`,
  `HttpOnly` and `SameSite` are accepted too.
- `--header` is sent only on requests to the target origin. Images,
  scripts and API calls to other origins don't get it, and neither does a
  redirect to another host (every redirect hop is checked).
- `--storage-state` and saved sessions load only the target origin's
  cookies and localStorage, even if the file holds others (an SSO domain,
  analytics).
- `--allow-origin https://api.example.com` widens all of the above to
  another origin, for an app that calls a separate API host.
- A saved session is used unless `--no-session` or `--storage-state` is
  given. Cookies and headers are added on top of it.

### Security notes

- **Values are never printed.** Plain, rich and `--json` output and MCP
  results show cookie and header names with `•••`. Console errors and
  failure messages are scrubbed of every value rpc injected. The `--json`
  result gains an `auth` field, for example
  `{"cookies":[{"name":"sid","value":"•••","domain":"localhost","path":"/"}]}`.
- **Session files are credentials.** They are written with mode 0600 in a
  0700 directory (`$XDG_CONFIG_HOME/rpc-agent/sessions` if set;
  `RPC_SESSIONS_DIR` overrides the location). Anyone who can read one can
  act as you on that site until it expires. `rpc sessions clear` deletes
  them. Don't commit a `--save` file.
- **Keep passwords out of shell history.** Prefer `RPC_LOGIN_PASSWORD` from
  a secret store over `--password`, which lands in your shell history and
  is visible to other users in the process list; rpc warns when you use it.
  The same goes for tokens in `--cookie` and `--header`: pass them from an
  environment variable (`--header "Authorization: Bearer $TOKEN"`), not
  literally.
- **Use a test account.** Sign in as a user whose data you're happy for
  screenshots (and the agent reading them) to see.

## MCP server

`rpc mcp` runs an MCP server on stdio with three tools.

### `screenshot`

| Param | Default | |
| --- | --- | --- |
| `url` | required | http(s), file, bare host or local path |
| `devices` | `["iphone-15-pro", "desktop-1440"]` | ids or aliases |
| `bezels` | false | framed copy of the first screen |
| `fullPage` | false | whole page, stitched past 16,384 px |
| `maxSlices` | 10 | full page: slices returned inline per device |
| `saveSlices` | auto | full page: `true` always writes slice JPEGs, `false` never; by default they are written only when some were cut by `maxSlices` |
| `sliceWidth` | 768 | full page: max slice width in px (raise it for small text on desktop) |
| `maxHeight` | 60000 | full page: CSS px cap |
| `reducedMotion` | false | emulate `prefers-reduced-motion: reduce` |
| `waitFor`, `waitMs`, `colorScheme`, `outDir`, `timeoutMs` | | as in the CLI |
| `inline` | true | return images, not just paths |
| `cookies` | | `[{ name, value, domain?, path? }]`, set on the target origin |
| `headers` | | `{ "Authorization": "Bearer …" }`, sent to the target origin only |
| `storageState` | | path to a Playwright storageState JSON |
| `useSession` | true when one exists | use the session saved by `rpc login` for the origin |
| `allowOrigins` | | extra origins that also get the headers and cookies |

The result starts with a plain-text block: one line per device (or the error
and hint), followed by the JSON summary (file paths, pixel sizes,
`scrollHeight`, `capturedHeight`, `segments`, `clipped`, `slices`, HTTP status,
final URL, title, console errors, `error`/`code`/`hint`).

Then the images:

- Without `fullPage`: one JPEG preview per device (the framed shot when
  `bezels`), at most 1024 px on the long side.
- With `fullPage`: the framed first screen when `bezels`, labelled
  `iphone-15 · first screen in bezel`, then the whole page as top-to-bottom
  slices, each one viewport tall and labelled
  `iphone-15 · slice 2/7 · y=852–1704 css px`. A three-device review of a
  typical marketing page is roughly 0.5 MB of JPEG.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/akintola4/rpc-agent/main/docs/media/mcp-slices-dark.png">
  <img alt="The first five labelled full-page slices returned for an iPhone 15 capture" src="https://raw.githubusercontent.com/akintola4/rpc-agent/main/docs/media/mcp-slices-light.png">
</picture>

When a page has more slices than `maxSlices`, the text says which ones were
skipped (`slices 11-26 (y=8520-21656 css px) skipped inline`), all slices are
written to disk and the summary gives their paths and the full PNG, so the
agent can Read the rest without slicing anything itself.

When auth is in play the text starts with an `auth:` line naming the
session, cookies and headers (values masked), and the JSON summary gains an
`auth` field. A capture that lands on a login page fails with
`AUTH_REQUIRED` and the `rpc login` hint. Signing in is something the user
does in a terminal (`rpc login`); the agent then just calls `screenshot`.

### `list_devices`

Takes an optional `category` (`apple-phone`, `android-phone`, `tablet`,
`laptop`) and returns ids, sizes and aliases.

### `list_sessions`

Lists the origins with a saved session: cookie count, when it was saved and
whether it has expired. Never returns values.

Files go to `outDir`, which is resolved against the server's working
directory. Claude Code and Cursor start the server in the project root; in
Codex, set `cwd` on the server to choose the directory.

### Claude Code

```sh
claude mcp add --scope user rpc -- npx -y rpc-agent mcp
```

Drop `--scope user` to add it to the current project only. Run
`npx rpc-agent install` once first so the server has a browser. If
`rpc-agent` is installed globally, `claude mcp add --scope user rpc -- rpc
mcp` skips the npx lookup on each start.

From a clone, point it at the build instead (the path must be absolute,
and Claude Code needs a restart or `/mcp` reconnect after rebuilding):

```sh
claude mcp add --scope user rpc -- node "$(pwd)/dist/cli.js" mcp
```

If you use the Claude Code sandbox, pages on hosts outside its network
allowlist fail with `ERR_NAME_NOT_RESOLVED` or a proxy error; the hint says
so. Add the domain to the allowlist.

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "rpc": {
      "command": "npx",
      "args": ["-y", "rpc-agent", "mcp"]
    }
  }
}
```

From a clone, use `"command": "node"` and
`"args": ["/absolute/path/to/rpc-agent/dist/cli.js", "mcp"]`.

### Codex

```sh
codex mcp add rpc -- npx -y rpc-agent mcp
```

Or add it to `~/.codex/config.toml` (or `.codex/config.toml` in a trusted
project). The Codex CLI and IDE extension read the same file:

```toml
[mcp_servers.rpc]
command = "npx"
args = ["-y", "rpc-agent", "mcp"]
```

From a clone, use `command = "node"` and
`args = ["/absolute/path/to/rpc-agent/dist/cli.js", "mcp"]`. `/mcp` in the
Codex TUI lists the servers it started.

## Development

```sh
pnpm test        # vitest: unit tests plus e2e captures of local fixtures
pnpm typecheck
pnpm build
pnpm smoke:mcp [url] [--full-page] [--devices a,b] [--max-slices n]
pnpm media       # regenerate the README images and GIF (needs ffmpeg)
```

The e2e tests serve `test/fixtures` locally. `tall.html` is 21,656 CSS px
(64,968 px at DPR 3): the test checks every row of the stitched PNG against
the known layout across all seams, that the sticky header and a fixed badge
appear once, that the IntersectionObserver section rendered, and the slice
count and labels, including through the MCP server. The missing-browser tests
point `PLAYWRIGHT_BROWSERS_PATH` at an empty temp dir.

The README media are built from real captures by `scripts/media/build.ts`;
`docs/media.md` explains how. The CLI's design notes, and what it borrows
from the `skills` CLI, are in `docs/cli-design.md`.

## Limitations

- Chromium only, portrait only. There is no landscape mode, and none of RPC's
  fake browser chrome bars.
- Scroll-driven animations are captured in their scroll-top state. Entrance
  animations that run once are usually fine after the warm-up scroll; ones
  that reverse when scrolled back (GSAP `toggleActions` with reverse, scrubbed
  timelines) may show their initial state. `reducedMotion` helps on sites that
  respect it.
- Very tall stitched PNGs are big files; review them through the slices.
- The bezel geometry is RPC's, unchanged. On kind-default phones the page
  covers the dynamic island or notch, and generic monitors are drawn edge to
  edge with only the stand showing.
- No scripted interaction before capture (beyond `rpc login --form`).
- Login-page detection goes by the URL path. An app that shows its sign-in
  form at the requested URL without redirecting is captured as is.
- Every MCP call launches a fresh Chromium, which adds about a second.

## License

MIT. Bezel artwork and device data come from Responsive Point Check; see `NOTICE`.
