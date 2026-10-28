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
interaction scripts before capture, visual diffing, HTTP/SSE MCP transport,
publishing to npm.

## Steps

1. Scaffold package (package.json, tsconfig, vitest, .gitignore), copy bezels + NOTICE. Commit.
2. Port devices + bezel layout with unit tests. Commit.
3. Arg parsing with tests. Commit.
4. capture + composite + CLI; e2e test against fixture. Commit.
5. MCP server + smoke script. Commit.
6. README. Commit.
7. Verify: CLI on fixture and example.com, inspect PNGs, MCP smoke, tests, typecheck.
