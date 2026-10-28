# rpc-agent

Screenshot a URL at real device viewports, optionally framed in a device
bezel, so an AI coding agent can look at the UI it just built. It's a CLI and
an MCP server in one package, with Playwright (Chromium) doing the capture.

The device catalog (49 phones, tablets, laptops and monitors) and the SVG
bezels come from the [Responsive Point Check](https://github.com/akintola4/responsive-point-check)
Chrome extension. See `NOTICE` for where the artwork comes from.

## Install

Requires Node 20+ and pnpm. Local only for now; nothing is published.

```sh
git clone <this folder> rpc-agent && cd rpc-agent
pnpm install
pnpm exec playwright install chromium
pnpm build
pnpm link --global   # optional: puts `rpc` on your PATH
```

Without the global link, run `node /path/to/rpc-agent/dist/cli.js` wherever
these docs say `rpc`, or `pnpm rpc` from inside the repo.

## CLI

```sh
rpc shot <url> [options]
rpc devices [--json]
rpc mcp
```

| Option | Meaning |
| --- | --- |
| `-d, --devices <ids>` | Comma-separated device ids or aliases. Default `iphone-15-pro,desktop-1440` |
| `-b, --bezels` | Also write a copy framed in the device bezel |
| `-f, --full-page` | Capture the full scroll height |
| `-o, --out <dir>` | Output directory. Default `./.rpc-shots` |
| `--wait-for <selector>` | Wait for a visible element before capturing |
| `--wait <ms>` | Extra settle delay after load |
| `--color-scheme <s>` | `light`, `dark` or `no-preference` |
| `--timeout <ms>` | Navigation timeout. Default 30000 |
| `--no-emulate` | Viewport and DPR only: no mobile user agent or touch |
| `--json` | Print the result as JSON |

The URL can be a full URL, a bare local host (`localhost:3000` becomes
`http://`), a bare domain (`example.com` becomes `https://`) or a path to a
local `.html` file.

```sh
rpc shot localhost:3000 -d iphone-15,ipad,desktop-1440 --bezels
rpc shot https://example.com/pricing --full-page --color-scheme dark
rpc shot localhost:5173 -d pixel --wait-for '[data-ready]' --json
```

Output files are named `<host>[-<path>]-<device>.png`, with
`-framed.png` added for bezel copies, for example
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
sockets don't hang it), web fonts and pending images. CSS animations are
finished before the shot.

With `--full-page`, rpc first scrolls through the page one viewport at a time
so lazy images and IntersectionObserver content load. It then scrolls back to
the top and takes one Playwright full-page capture. Sticky headers appear
once, at the top, and `100vh` sections keep their real height. Pages taller
than 16,384 device pixels are cut off at that height and marked `clipped`.

Bezels frame the above-the-fold viewport. With `--bezels --full-page` you get
both files: the full page raw, and the first screen framed.

## MCP server

`rpc mcp` runs an MCP server on stdio with two tools.

`screenshot` takes `url` (required), `devices` (string[]), `bezels`,
`fullPage`, `waitFor`, `waitMs`, `colorScheme`, `outDir`, `timeoutMs` and
`inline`. It returns a JSON summary per device: file paths, pixel sizes, HTTP
status, final URL, page title, scroll height and console errors. With `inline`
(the default) it also returns a JPEG preview per device, at most 1024 px on
the long side and usually under 50 KB. Tall pages are cropped to the top of
the page so the text stays readable; the full PNG is on disk.

`list_devices` takes an optional `category` (`apple-phone`, `android-phone`,
`tablet`, `laptop`) and returns ids, sizes and aliases.

Files go to `outDir`, which is resolved against the server's working
directory. Claude Code and Cursor start the server in the project root.

### Claude Code

```sh
claude mcp add rpc -- node /absolute/path/to/rpc-agent/dist/cli.js mcp
```

Add `--scope user` to make it available in every project.

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "rpc": {
      "command": "node",
      "args": ["/absolute/path/to/rpc-agent/dist/cli.js", "mcp"]
    }
  }
}
```

## Development

```sh
pnpm test        # vitest: devices, bezel layout, arg parsing, e2e capture
pnpm typecheck
pnpm build
pnpm smoke:mcp   # spawns dist/cli.js mcp and calls both tools
```

The e2e test serves `test/fixtures/page.html` locally and checks image sizes.
It also samples pixels to confirm the page sits inside each bezel's screen
area and that lazy content rendered.

## Limitations

- Chromium only, portrait only. There is no landscape mode, and none of RPC's
  fake browser chrome bars.
- The bezel geometry is RPC's, unchanged. On kind-default phones the page
  covers the dynamic island or notch, and generic monitors are drawn edge to
  edge with only the stand showing.
- No auth, cookies, custom headers or scripted interaction before capture.
- Every MCP call launches a fresh Chromium, which adds about a second.

## License

MIT. Bezel artwork and device data come from Responsive Point Check; see `NOTICE`.
