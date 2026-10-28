# Changelog

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
