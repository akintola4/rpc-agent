# Changelog

## Unreleased

### Fixed

- `rpc check`: the tap-target check skips inline links in a sentence (WCAG
  2.5.8 inline exception). A link is skipped when its computed `display` is
  `inline` and its block of text has letters or digits outside any
  control. Buttons, `[role=button]`, links laid out as boxes, nav links and
  icon links still count, and the threshold stays 44x44.
- Test servers answer 500 with the error when a fixture file is missing
  instead of hanging, and the check suite stops early with "run pnpm
  install" when `@fontsource/ibm-plex-mono` isn't installed.

## 0.5.0

Ship-check: `rpc check <url>` audits a page before launch, from the CLI, in
CI or through MCP.

### Added

- `rpc check <url>` runs on a phone and a desktop width by default (`-d`
  to change) and reports findings with an id, severity (`error`, `warn`,
  `info`), message, selector or URL, devices and a fix. Checks:
  - Basics: HTTP status, mixed content, uncaught exceptions, console errors,
    `theme-color`.
  - Meta and social: title, description, canonical, `lang`, viewport (and
    zoom blocking), favicon, apple-touch-icon, `og:title`,
    `og:description`, `og:image`, `og:url`, `twitter:card`. `og:image` is
    fetched for its status, content type and pixel size.
  - Layout shift: CLS (largest session window) after load and one scroll,
    with the elements that moved. Warn above 0.1, error above 0.25.
  - Unlabelled controls: buttons, links and `[role=button]` with no
    accessible name, images without `alt`, form fields without a label.
  - Fonts: missing or `block` `font-display`, above-the-fold fonts that
    aren't preloaded, preloads without `crossorigin`, unused preloads,
    font files that fail.
  - Mobile viewport (phones): `100vh`, sideways scroll with the elements
    that cause it, tap targets under 44x44, text fields under 16px.
- Exit code 1 on errors; `--fail-on warn` fails on warnings too.
  `--json` prints a versioned report (`schema: 1`, documented in the
  README). `--shots` saves PNGs of the elements behind layout-shift and
  overflow findings.
- Auth works as for `rpc shot`: `--cookie`, `--header`,
  `--storage-state`, `--allow-origin`, saved `rpc login` sessions and
  `AUTH_REQUIRED` on a redirect to sign-in.
- MCP `check` tool with the same options and the `screenshot` tool's auth
  params. It returns a short text summary and the JSON report.

### Unchanged

- `rpc shot`, its output and the MCP `screenshot` tool. The MCP tool list
  gains `check`.

## 0.4.0

Authenticated captures: screenshot logged-in pages without a hand-written
"sign in, then screenshot" script.

### Added

- `rpc login <url>` opens a browser window; sign in, press Enter (or close
  the window) and the storage state is saved for that origin to
  `~/.config/rpc-agent/sessions/<origin>.json` (file 0600, directory 0700).
  `--save <file>` writes it elsewhere.
- `rpc login <url> --form`: headless email + password sign-in for CI and
  agents, from `RPC_LOGIN_EMAIL` / `RPC_LOGIN_PASSWORD` (or `--email` /
  `--password`), with `--email-selector`, `--password-selector` and
  `--submit-selector`.
- `rpc shot` uses the saved session for the target origin automatically.
  `--no-session` opts out. `rpc sessions [list]` and
  `rpc sessions clear [origin]` manage them.
- `rpc shot --cookie "name=value[; Domain=…; Path=…]"`, `--header
  "Name: value"` (both repeatable), `--storage-state <file>` and
  `--allow-origin <origin>`.
- A capture redirected to a login page (`/login`, `/sign-in`, `/auth`, …)
  fails with code `AUTH_REQUIRED` and the hint ``Session missing or
  expired: run `rpc login <origin>` `` instead of screenshotting the sign-in
  form. Sessions whose cookies have all expired aren't loaded.
- MCP `screenshot` takes `cookies`, `headers`, `storageState`, `useSession`
  and `allowOrigins`. New `list_sessions` tool.
- `rpc install --headed` also downloads full Chromium, for the
  `rpc login` window. Without it, `rpc login` uses an installed Google
  Chrome if there is one.

### Security

- Headers and cookies go to the target origin only (plus any
  `--allow-origin`). Headers are injected per request through the CDP Fetch
  domain, so a redirect to another host doesn't carry them. Saved sessions
  and storage-state files load only the target origin's cookies and
  localStorage.
- Cookie, header and localStorage values are never printed: output shows
  names with `•••`, and console errors and failure messages are scrubbed.
- `--password` prints a warning; use the environment variable.

### Changed

- A page that redirects to a login URL now fails that device with
  `AUTH_REQUIRED` (exit code 1) even when no auth was given. In 0.3 it
  screenshotted the sign-in page and reported success.

### Unchanged

- With no auth in play, plain output, `--json` output and MCP results are
  the 0.3 ones. With auth, they gain an `auth:` line / an `auth` field.
  Existing MCP params and result fields are unchanged.

## 0.3.1

Published to npm as `rpc-agent`.

### Added

- Install with `npx rpc-agent …` or `npm i -g rpc-agent`. MCP setup for
  Claude Code is `claude mcp add --scope user rpc -- npx -y rpc-agent mcp`;
  Cursor uses `"command": "npx", "args": ["-y", "rpc-agent", "mcp"]`.
- Package metadata (repository, homepage, bugs, keywords, author) and a
  `prepublishOnly` check that typechecks, builds and runs the tests.

### Changed

- The missing-Chromium message now says `npx rpc-agent install` (or
  `rpc install`) and names the Playwright version, instead of pointing at
  `npx playwright install chromium` inside the package folder, which under
  npx is a cache directory and could pull a different Playwright.
- `rpc install` run through npx no longer shows Playwright's "install your
  project's dependencies" warning box, which didn't apply.
- `rpc install` downloads only Chromium's headless shell (`--only-shell`),
  which is all rpc launches: about 210 MB on disk instead of about 580 MB.
- Requires Node 20.12 or newer (what `@clack/prompts` needs).
- Chromium is still never downloaded on install: run `rpc install` once.

## 0.3.0

A terminal UI modelled on the `skills` CLI (skills.sh). Nothing changes for
agents, scripts or CI.

### Added

- `rpc` with no arguments, in a terminal, is an interactive capture: URL
  (defaults to a running dev server on localhost), a grouped device picker,
  bezels / full page / dark mode / reduced motion, a summary and a confirm.
  It ends with the equivalent `rpc shot` command.
- `rpc shot` in a terminal: `RPC` banner, a capture summary, a spinner per
  device that resolves to status and time, a results table (status, time,
  console errors), the files written with pixel and file sizes, failures
  grouped with their hint, and `Done!  Open with: open .rpc-shots`.
- `--open` opens the output folder when the capture finishes.
- `rpc devices` in a terminal: aligned, coloured by category, with each
  device's aliases. `rpc doctor` in a terminal: a checklist with the fix in
  a box.
- Per-command help: `rpc help shot`, `rpc shot --help` (also devices,
  doctor, install, mcp). `rpc --help` in a terminal has sections and
  examples.
- `docs/cli-design.md`: what rpc borrows from the `skills` CLI and when the
  rich output is used.

### Unchanged

- Output to pipes, files and CI (`CI` set, `TERM=dumb`) is the 0.2 output.
  `--json` output, exit codes and the MCP server are untouched; `rpc mcp`
  and `--json` don't load the UI code. `NO_COLOR` turns colour off and
  `FORCE_COLOR` turns it on for the plain output.

### Dependencies

- `@clack/prompts` and `picocolors`.

## 0.2.0

From the first real use: an agent reviewing a deployed site on iphone-15,
ipad and desktop-1440 with bezels and full page.

### Added

- Full pages of any height. Pages taller than Chromium's 16,384 px capture
  limit are taken as clipped full-page segments and stitched in Node (no
  native dependencies). Sticky headers and fixed elements appear once. New
  `maxHeight` / `--max-height` cap (60,000 CSS px), reported as `clipped`,
  with `capturedHeight` and `segments` in the result.
- Full-page review in one MCP call. With `fullPage`, `screenshot` returns the
  framed first screen and then the whole page as labelled, viewport-tall JPEG
  slices (`iphone-15 · slice 2/7 · y=852–1704 css px`). New params
  `maxSlices` (10), `saveSlices` and `sliceWidth` (768). When slices are cut,
  the result says which range was skipped, and every slice is saved to disk
  with its path listed. CLI: `--slices`, `--slice-width`.
- Actionable errors. Navigation failures come back per device as `error`,
  `code` (`ERR_NAME_NOT_RESOLVED`, `TIMEOUT`, ...) and `hint`, covering
  sandbox / network allowlists, dev servers not running, proxies, TLS and
  timeouts. MCP results lead with the failures in plain text.
- `reducedMotion` / `--reduced-motion` emulates
  `prefers-reduced-motion: reduce`.
- Missing-browser check. If Playwright's Chromium isn't installed, the CLI and
  the MCP tool say so with the fix (`npx playwright install chromium`, or
  `rpc install`) instead of Playwright's raw error; the MCP server keeps
  running. New `rpc doctor` and `rpc install` commands.

### Changed

- The warm-up scroll covers the whole capped height (up to 100 steps) rather
  than stopping at 30,000 px.
- `pnpm smoke:mcp` takes `--full-page`, `--devices`, `--max-slices`, `--out`.

## 0.1.0

First version: CLI and stdio MCP server, 49 devices and bezels from
Responsive Point Check, Playwright Chromium capture, bezel compositing in a
Playwright page.
