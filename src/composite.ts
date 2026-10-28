import type { Browser, Page } from 'playwright';
import { bezelLayoutFor, loadBezelSvg } from './bezel.js';
import type { Device } from './devices.js';

/** Any origin works; requests to it never leave the process (page.route). */
const ORIGIN = 'http://rpc-compositor.invalid';

/** Long-side cap for framed output so 3x phones and 2x 27" displays stay sane. */
export const MAX_FRAMED_PX = 4096;

/**
 * Serve `html` at ORIGIN/ and `image` at ORIGIN/shot.png from a throwaway
 * page, then run `fn`. Routing avoids stuffing multi-MB data: URLs into
 * setContent.
 */
async function withStage<T>(
  browser: Browser,
  viewport: { width: number; height: number },
  deviceScaleFactor: number,
  html: string,
  image: Buffer,
  fn: (page: Page) => Promise<T>
): Promise<T> {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  try {
    const page = await context.newPage();
    await page.route(`${ORIGIN}/**`, route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/shot.png') {
        return route.fulfill({ status: 200, contentType: 'image/png', body: image });
      }
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    });
    await page.goto(`${ORIGIN}/`);
    // String predicate: see the note on in-page scripts in capture.ts.
    await page.waitForFunction(`Array.from(document.images).every(i => i.complete)`);
    return await fn(page);
  } finally {
    await context.close();
  }
}

/** Strip the root <svg>'s fixed width/height so CSS can size it, as RPC does. */
function prepareSvg(svg: string): string {
  return svg.replace(/<svg\b[^>]*>/, tag =>
    tag.replace(/\s(width|height)="[^"]*"/g, '').replace(
      '<svg',
      '<svg style="position:absolute;left:0;top:0;width:100%;height:100%"'
    )
  );
}

/**
 * Composite a viewport screenshot into the device bezel. Mirrors RPC's
 * frame.ts: SVG fills the outer box underneath, the page sits on top at the
 * screen rect with the screen's corner radius. Output has a transparent
 * background and the device's DPR (capped by MAX_FRAMED_PX).
 */
export async function renderFramed(
  browser: Browser,
  device: Device,
  viewportPng: Buffer
): Promise<Buffer> {
  const layout = bezelLayoutFor(device);
  const { screen } = layout;
  const scale = Math.min(device.dpr, MAX_FRAMED_PX / Math.max(layout.outerWidth, layout.outerHeight));
  const html = `<!doctype html><html><head><style>
  html,body{margin:0;background:transparent}
  #frame{position:relative;width:${layout.outerWidth}px;height:${layout.outerHeight}px}
  #bezel{position:absolute;inset:0;z-index:1}
  #screen{position:absolute;z-index:2;display:block;left:${screen.x}px;top:${screen.y}px;
    width:${screen.width}px;height:${screen.height}px;border-radius:${screen.radius}px;object-fit:fill}
</style></head><body><div id="frame"><div id="bezel">${prepareSvg(loadBezelSvg(layout.src))}</div>
<img id="screen" src="/shot.png" alt=""></div></body></html>`;

  return withStage(
    browser,
    { width: layout.outerWidth, height: layout.outerHeight },
    scale,
    html,
    viewportPng,
    page => page.locator('#frame').screenshot({ omitBackground: true, type: 'png' })
  );
}

export interface PreviewOptions {
  /** Longest side of the preview, in px. */
  maxDim?: number;
  /** Crop tall images to at most this height:width ratio before scaling. */
  maxAspect?: number;
  quality?: number;
}

/**
 * Small JPEG for returning inline over MCP. Tall full-page shots are cropped
 * to the top `maxAspect` region first so text is still legible after scaling.
 */
export async function renderPreview(
  browser: Browser,
  png: Buffer,
  size: { width: number; height: number },
  { maxDim = 1024, maxAspect = 3, quality = 70 }: PreviewOptions = {}
): Promise<{ data: Buffer; width: number; height: number; cropped: boolean }> {
  const srcH = Math.min(size.height, Math.round(size.width * maxAspect));
  const cropped = srcH < size.height;
  const scale = Math.min(1, maxDim / Math.max(size.width, srcH));
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  const html = `<!doctype html><html><head><style>
  html,body{margin:0;background:#fff}
  #c{width:${width}px;height:${height}px;overflow:hidden}
  img{display:block;width:${width}px;height:auto}
</style></head><body><div id="c"><img src="/shot.png" alt=""></div></body></html>`;
  const data = await withStage(browser, { width, height }, 1, html, png, page =>
    page.locator('#c').screenshot({ type: 'jpeg', quality })
  );
  return { data, width, height, cropped };
}
