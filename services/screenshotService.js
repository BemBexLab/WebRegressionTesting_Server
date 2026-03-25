import { chromium } from "playwright";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 }
};

const PAGE_GOTO_TIMEOUT = Number(process.env.PAGE_GOTO_TIMEOUT_MS) || 45000;
const POST_LOAD_DELAY = Number(process.env.POST_LOAD_DELAY_MS) || 6000;
const SCROLL_STEP_DELAY = Number(process.env.SCROLL_STEP_DELAY_MS) || 150;
const NETWORK_IDLE_TIMEOUT = Number(process.env.NETWORK_IDLE_TIMEOUT_MS) || 20000;
const PAGE_GOTO_MAX_RETRIES = Number(process.env.PAGE_GOTO_MAX_RETRIES) || 5;
const PAGE_GOTO_RETRY_DELAY_MS = Number(process.env.PAGE_GOTO_RETRY_DELAY_MS) || 5000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gotoWithRetry(page, url) {
  let attempt = 0;
  let lastError = null;

  while (attempt < PAGE_GOTO_MAX_RETRIES) {
    attempt += 1;
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_GOTO_TIMEOUT });
    } catch (error) {
      lastError = error;
      console.warn(
        `page.goto failed (attempt ${attempt}/${PAGE_GOTO_MAX_RETRIES}) for ${url}:`,
        error?.message ?? error
      );
      if (attempt < PAGE_GOTO_MAX_RETRIES) {
        await delay(PAGE_GOTO_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

async function stabilizePage(page) {
  await page.emulateMedia({ reducedMotion: "reduce" }).catch(() => {});
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
      }
      video,
      iframe {
        animation: none !important;
      }
    `
  }).catch(() => {});

  await page.evaluate(async (stepDelay) => {
    if (document.fonts?.ready) {
      await document.fonts.ready.catch(() => {});
    }

    const totalHeight = Math.max(
      document.body?.scrollHeight ?? 0,
      document.documentElement?.scrollHeight ?? 0
    );
    const step = window.innerHeight || 800;

    for (let position = 0; position < totalHeight; position += step) {
      window.scrollTo(0, position);
      await new Promise((resolve) => window.setTimeout(resolve, stepDelay));
    }

    window.scrollTo(0, 0);
  }, SCROLL_STEP_DELAY).catch(() => {});
}

export async function captureScreenshot({
  url,
  outputPath,
  viewport = "desktop",
  ignoredSelectors = []
}) {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport: VIEWPORTS[viewport] ?? VIEWPORTS.desktop
    });

    await gotoWithRetry(page, url);
    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(POST_LOAD_DELAY);
    await stabilizePage(page);

    if (ignoredSelectors.length > 0) {
      const css = ignoredSelectors
        .map((selector) => `${selector} { visibility: hidden !important; }`)
        .join("\n");

      await page.addStyleTag({ content: css });
    }

    await page.screenshot({
      path: outputPath,
      fullPage: true
    });

    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}
