# rpc-agent: design and implementation plan

RPC for agents. A local TypeScript package that screenshots a URL at one or
more device viewports, optionally framed in a device bezel, so an AI coding
agent (Claude Code, Cursor) can look at its own UI work. Derived from the
`akintola4/responsive-point-check` Chrome extension (RPC).

One package, two front doors:

- a CLI: `rpc shot <url> --devices iphone-15,ipad,desktop-1440 --bezels --full-page`
- an MCP server over stdio: `rpc mcp`, exposing the same capture as tools.

Both call the same `capture()` function. Playwright (Chromium) does the work.

## What RPC does today (source reading)

**Device data** (`lib/devices.ts`). 49 devices in four categories
(apple-phone, android-phone, tablet, laptop). Each has `id`, `name`,
portrait CSS `width`/`height`, `dpr`, and a `bezel` kind (phone-island,
phone-notch, phone-classic, phone-home, tablet, laptop, monitor). Some
devices add `bezelSrc` (a per-device SVG) and `bezelLayout` (outer artwork
size plus the exact screen rect, in px). RPC sets no user agent: it renders
every device as an iframe inside desktop Chrome.

**Bezel geometry** (`lib/bezel-asset.ts`). `buildBezelLayout()` returns
`{ src, outerWidth, outerHeight, screen: { x, y, width, height, radius } }`.
With a per-device `bezelLayout` it uses those numbers. Otherwise it pads the
viewport using per-kind constants (absolute px or ratios of the viewport) from
`BEZEL_PADDING`. Landscape reflects the rect; not needed for v1.

**Compositing** (`entrypoints/panel/frame.ts`, `style.css`). The SVG is inlined
into an absolutely positioned layer the size of the outer box
(`width:100%;height:100%`, the SVG's own `width`/`height` attributes removed so
the default `preserveAspectRatio: xMidYMid meet` applies). The iframe sits on
top (`z-index: 2` over the bezel's `z-index: 1`) at the screen rect with
`border-radius: screen.radius`. The SVGs draw a filled screen area, so the
content must be layered over it, not under a cutout.

**Screenshots** (`entrypoints/panel/right-rail.ts`). `captureVisibleTab` then
crop to the iframe (site only) or the `.frame` (with mockup). Full page is
scroll-and-stitch: read `scrollHeight`, scroll the iframe one viewport at a
time, wait two rAFs + 120 ms for lazy media, capture, paint each segment into
a tall canvas. It stitches because an extension cannot capture beyond the
visible tab. Known issue noted in the code: sticky/fixed elements repeat in
every segment. Mockup is only ever applied to the visible viewport.

**Bezel asset licensing.** The extension repo is MIT (Copyright 2026 Akintola
Tope). The 21 SVGs in `public/bezels/` carry no license or author metadata.
Their `clip0_284_941`-style ids indicate Figma exports, but the upstream Figma
file is not recorded anywhere in the repo, README or CHANGELOG. They are
redistributed here under the repo's MIT license, with a NOTICE that the
original artwork source is undocumented and that the artwork depicts Apple,
Google, Samsung and Microsoft hardware whose product names and designs are
those companies' trademarks. Confirm the origin before any public release.

## Decisions

**Full page: Playwright `fullPage: true`, not stitching.** Playwright on
Chromium captures beyond the viewport in one pass, so sticky headers and fixed
elements appear once instead of once per segment, and there are no seams.
The viewport is not resized, so `100vh` heroes keep their real height. To keep
what the stitch delay was for (lazy media), we do a warm-up pass first: scroll
through the page one viewport at a time (bounded: max 40 steps / 30k px),
pausing briefly so `loading="lazy"` images and IntersectionObserver content
trigger, scroll back to the top, then wait for network idle and fonts again.
Very tall pages are capped at 16,384 device px tall by Chromium; we clip and
report it.

**Emulation.** Each device gets its own browser context with `viewport`,
`deviceScaleFactor = dpr`, `isMobile` and `hasTouch` for phones/tablets, and a
category user agent (iOS Safari for Apple phones and iPads, Android Chrome for
Android, desktop Chrome for laptops/monitors). This is an addition over RPC and
is what most agents actually want (UA-sniffing sites, touch media queries).
`--no-emulate` falls back to RPC behaviour: viewport + DPR only.

**Bezel compositing: render in a Playwright page.** No `sharp`. We open a blank
page sized to the outer box, inline the SVG exactly as RPC does, place the
screenshot as an `<img>` at the screen rect with the same border radius, and
take an element screenshot with a transparent background. The compositor page
uses the device DPR so the framed shot has the same pixel density as the raw
one, scaled down if the result would exceed 4096 px on its long side. Same
layout code, same CSS rules as the extension, so alignment matches what users
see in RPC.

**Bezels + full page.** A bezel frames one screen. When both are set we write
two files per device: the raw full-page shot and a framed above-the-fold shot.

**Inline images for MCP.** Tool results always list file paths. By default they
also include one inline JPEG preview per device, produced by the same
Playwright page (scale to fit within 1024 px on the long side; full-page shots
are cropped to the top 3:1 region before scaling so text stays readable). Set
`inline: false` to get paths only. This keeps a three-device call well under
1 MB of base64.

## CLI surface

```
rpc shot <url> [options]
  -d, --devices <ids>       comma list of device ids or aliases (default: iphone-15-pro,desktop-1440)
  -b, --bezels              frame each shot in its device bezel
  -f, --full-page           capture the whole scroll height
  -o, --out <dir>           output dir (default: ./.rpc-shots)
      --wait-for <selector> wait for this selector before capturing
      --wait <ms>           extra settle delay after load (default 0)
      --color-scheme <s>    light | dark | no-preference
      --timeout <ms>        navigation timeout (default 30000)
      --no-emulate          viewport + DPR only, no mobile UA/touch
      --json                print the result as JSON
rpc devices [--json]        list devices and aliases
rpc mcp                     start the MCP server on stdio
```

Aliases: `iphone` → iphone-15-pro, `ipad` → ipad-air-11, `pixel` → pixel-8,
`galaxy` → galaxy-s24, `macbook` → macbook-air-13, `laptop` → laptop-1280,
`desktop` → desktop-1440, `mobile` → iphone-15-pro, `tablet` → ipad-air-11.
Unknown ids fail fast with a suggestion of close matches.

Output: `<out>/<host>-<device>.png`, `<host>-<device>-framed.png` when bezels
are on. Host is slugified (`localhost-3000`, `example-com`). Re-running
overwrites, so paths are deterministic for agents. The CLI prints one line per
file; `--json` prints the structured result.

## MCP tools

`screenshot`

| field | type | default |
| --- | --- | --- |
| url | string (http/https/file) | required |
| devices | string[] | `["iphone-15-pro", "desktop-1440"]` |
| bezels | boolean | false |
| fullPage | boolean | false |
| waitFor | string (CSS selector) | none |
| waitMs | number | 0 |
| colorScheme | `light` \| `dark` \| `no-preference` | none |
| outDir | string | `./.rpc-shots` (relative to server cwd) |
| inline | boolean | true |

Returns a text block with a JSON summary (device, viewport, dpr, file paths,
pixel size, page title, final URL, console errors count, clipped flag) and,
when `inline`, one image block per device.

`list_devices` with optional `category`. Returns the device table and aliases
as text.

## Project layout

```
src/
  devices.ts      device catalog ported from RPC + user agents + aliases + resolveDevices()
  bezel.ts        buildBezelLayout() ported from RPC, SVG loading from assets/bezels
  capture.ts      capture(): browser lifecycle, per-device context, navigation, warm-up, screenshot
  composite.ts    framed image + inline preview rendering via a Playwright page
  png.ts          read PNG width/height from the IHDR chunk
  args.ts         CLI argument parsing (node:util parseArgs), pure and testable
  cli.ts          bin entry: shot / devices / mcp
  mcp.ts          MCP server (stdio) with screenshot + list_devices
assets/bezels/    SVGs copied from RPC public/bezels
test/
  devices.test.ts, args.test.ts, bezel.test.ts, e2e.test.ts
  fixtures/page.html   static page with a sticky header, 100vh hero, lazy image, tall content
scripts/mcp-smoke.ts   SDK client that spawns `rpc mcp` and calls both tools
NOTICE            bezel artwork provenance
```

Dependencies: `playwright`, `@modelcontextprotocol/sdk`, `zod`. Dev:
`typescript`, `vitest`, `@types/node`, `tsx`. Node 20+, ESM, pnpm.

## Tests

- devices: every id unique, aliases resolve to real ids, all `bezelSrc` files
  exist, unknown ids throw with suggestions, UA per category.
- bezel: layout for a per-device override is returned as-is; kind defaults
  contain the viewport exactly (`outer = screen + padding`); every device's
  screen rect equals its viewport.
- args: defaults, comma lists, aliases, bad color scheme, missing URL.
- e2e: serve `test/fixtures` from a local `http.createServer`, capture two
  devices with bezels + full page, assert files exist, PNG dimensions equal
  viewport × DPR (and full-page height > viewport), framed size equals outer ×
  DPR, and that a pixel sampled at the screen centre in the framed shot matches
  the fixture's background colour (alignment check).

## Out of scope for v1

Landscape orientation, browser chrome overlays (RPC's fake Safari/Chrome
bars), breakpoint guides, Firefox/WebKit engines, auth/cookies/headers,
interaction scripts before capture, visual diffing, HTTP/SSE MCP transport.
(Publishing to npm was out of scope for v1; it ships from 0.3.1.)

## Steps

1. Scaffold package (package.json, tsconfig, vitest, .gitignore), copy bezels + NOTICE. Commit.
2. Port devices + bezel layout with unit tests. Commit.
3. Arg parsing with tests. Commit.
4. capture + composite + CLI; e2e test against fixture. Commit.
5. MCP server + smoke script. Commit.
6. README. Commit.
7. Verify: CLI on fixture and example.com, inspect PNGs, MCP smoke, tests, typecheck.

## v0.2 changes

Driven by the first real use (an agent reviewing a deployed portfolio on
iphone-15, ipad and desktop-1440 with bezels + full page).

**1. Actionable navigation errors.** A new `errors.ts` maps Playwright /
Chromium failures to `{ error, code, hint }`. `code` is the `net::ERR_*` name,
`TIMEOUT`, `WAIT_FOR_TIMEOUT` or `UNKNOWN`. Hints cover DNS failures
(misspelt host, or the host is blocked by a sandbox / network allowlist such
as the Claude Code sandbox: nslookup can resolve while the sandboxed process
cannot), refused connections (dev server not running on that port for local
hosts; firewall / allowlist otherwise), proxy / tunnel / offline errors,
TLS errors (https against a plain-http dev server), missing files and
navigation timeouts. Each device fails on its own; `DeviceShot` gains `code`
and `hint`. The CLI prints the hint under the error, and the MCP result
starts with a plain-text line per failed device before the JSON.

**2. Full-page review in one MCP call.** With `fullPage`, the `screenshot`
tool returns the whole page as top-to-bottom JPEG slices, each one viewport
tall, at most `sliceWidth` px wide (default 768), labelled
`iphone-15 · slice 2/7 · y=852–1704 css px`. With bezels, the framed first
screen comes first as the hero image. `maxSlices` (default 10 per device)
caps the inline payload; when slices are cut the summary says which y range
was skipped, all slices are written to disk, and the paths are listed.
`saveSlices: true` always writes `<stem>-slice-NN.jpg` files. Slicing math
(`planSlices`) is pure and unit tested; slices are rendered in the existing
compositor page from the capture segments, so no image ever has to fit a
canvas. Non-full-page behaviour is unchanged. CLI: `--slices`,
`--max-slices`, `--slice-width`.

**3. No 16,384 px height limit.** Experiment: `page.screenshot({ fullPage:
true, clip })` with a clip that starts beyond 16,384 device px works in
Chromium and renders exactly what the single full-page capture would
(captureBeyondViewport: sticky headers sit at their scroll-0 position, fixed
elements appear once, nothing scrolls). So tall pages are captured as clipped
segments of at most ~8,000 device px each (segment height chosen so each
boundary is a whole device pixel) and stitched in Node: a small PNG decoder /
encoder on `node:zlib` (8-bit RGB/RGBA, non-interlaced: what Chromium
emits), streaming rows into one deflate stream so peak memory is about one
segment. No sharp, no canvas size limit. Pages that fit in one capture still
use a single capture. Absolute cap: 60,000 CSS px (`maxHeight`), reported
with `clipped: true` and `capturedHeight`. The warm-up scroll now covers the
full capped height (step one viewport, 100 steps max).

**4. Animations.** Optional `reducedMotion` (`--reduced-motion`) emulates
`prefers-reduced-motion: reduce`, which makes Framer Motion and most GSAP
setups skip entrance animations. Playwright's `animations: 'disabled'`
already finishes CSS animations/transitions and WAAPI before each capture.
Nothing more invasive.

Tests: unit tests for error mapping, slice planning and PNG encode/decode
round trip; e2e on `test/fixtures/tall.html` (21,656 CSS px at DPR 3 =
64,968 device px) asserting stitched height, alternating band colours across
every seam, a single header and fixed badge, lazy section revealed; slice
count and labels through the MCP server over an in-memory transport.

**5. Missing Chromium.** (Added during v0.2.) `launchBrowser()` turns
Playwright's "Executable doesn't exist" into one message with the fix
(`npx rpc-agent install`, or `rpc install`). The
MCP tool returns it as a tool error and the server keeps running. `rpc
doctor` launches Chromium to check it; `rpc install` runs this package's own
`playwright install chromium`. Tested by pointing `PLAYWRIGHT_BROWSERS_PATH`
at an empty temp dir. (From 0.3.1 the package is on npm and the message
names `npx rpc-agent install`; Chromium is never downloaded by a postinstall.)

## v0.3 CLI UX

The CLI should feel like the `skills` CLI behind skills.sh. Research and the
reasoning behind each choice are in `docs/cli-design.md`; this is the plan.

**Two output modes.** Rich output (banner, clack rail, spinners, prompts,
boxed summaries, colour) only when stdout is a TTY, `CI` is unset, `TERM`
isn't `dumb` and `--json` isn't given. In every other case the CLI prints
exactly what 0.2 printed, so agents, scripts and CI logs see no change.
`--json` output, exit codes and `rpc mcp` are untouched: the MCP path never
imports the UI module, and the UI module is loaded lazily by the other
commands. `NO_COLOR` turns colour off (rich layout stays); `FORCE_COLOR`
turns colour on for the plain layout too.

**`rpc` with no args (TTY).** Banner (`RPC` block wordmark, grey gradient),
`rpc` badge, then:

1. URL prompt, validated with `normalizeUrl`. If something answers on
   localhost:3000 (or 5173, 4321, 8080), that's the default.
2. Grouped multi-select of all 49 devices (Apple phones, Android phones,
   tablets, laptops and desktops), with iphone-15-pro, ipad-air-11 and
   desktop-1440 preselected.
3. Multi-select of options: bezels (on), full page, dark mode, reduced
   motion.
4. `Capture Summary` box, `Proceed with capture?` confirm.
5. The capture itself, exactly as `rpc shot` runs it, plus a dim
   `rpc shot …` line with the equivalent command so it can be re-run.

Without a TTY, `rpc` alone still prints the usage text.

**`rpc shot` (TTY).** Banner and badge, a `Capture Summary` box (no
confirm), a spinner while Chromium starts, one spinner per device that
resolves to `◇ iphone-15-pro  393×852 @3x  200 · 1.4s` (or a red error
line), then a results table (device, viewport, status, time, console
errors), a `Captured N devices` box listing each file (cyan path, pixel
size, file size) and each failure with its hint, and an outro:
`Done!  Open with: open .rpc-shots`. Options and behaviour are unchanged.
New `--open` flag opens the output folder when done (`open` on macOS,
`xdg-open` on Linux, `explorer` on Windows); it works in every mode.
`capture()` gains an optional `onDeviceStart` hook for the spinners.

**`rpc devices` (TTY).** Same groups, coloured category headings with a
count, aligned columns: id (cyan), CSS size, DPR, name (dim), and the
aliases that point at each device. `--json` unchanged.

**`rpc doctor` (TTY).** A checklist on the rail: node, Playwright,
browsers path, Chromium launch (green ◆ / red ■) and the fix in a box when
it fails. `rpc install` ends with the same checklist.

**Help.** `rpc --help` in a TTY: bold section headings, aligned commands,
dim descriptions, `$` examples with aligned dim comments. Per-command help:
`rpc shot --help`, `rpc help shot` (also for devices, doctor, install, mcp).
`rpc --help` without a TTY prints the 0.2 usage text unchanged.
`--version` prints the bare version in every mode.

**Dependencies.** `@clack/prompts` and `picocolors`, nothing else.

**Tests.** Mode decisions (TTY, CI, TERM, `--json`, `NO_COLOR`,
`FORCE_COLOR`) as a pure function; the rich renderers (device table,
results table, capture boxes) render without escape codes under
`NO_COLOR`; spawned non-TTY runs of `devices`, `--help`, no-args and
`shot … --json` (with `FORCE_COLOR=1`) are byte-compatible with 0.2 and
contain no escape codes; argument parsing accepts every 0.2 flag plus
`--open` and per-command `--help`. The real TTY experience is checked by
running the built CLI in a pseudo-terminal, and `pnpm smoke:mcp` proves the
MCP server is unaffected.
