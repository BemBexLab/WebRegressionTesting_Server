import { launchBrowser } from "./browserService.js";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 }
};

const IS_SERVERLESS =
  process.env.VERCEL === "1" || Boolean(process.env.AWS_REGION) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const PAGE_GOTO_TIMEOUT = Number(process.env.PAGE_GOTO_TIMEOUT_MS) || (IS_SERVERLESS ? 20000 : 45000);
const POST_LOAD_DELAY = Number(process.env.POST_LOAD_DELAY_MS) || (IS_SERVERLESS ? 1500 : 6000);
const SCROLL_STEP_DELAY = Number(process.env.SCROLL_STEP_DELAY_MS) || 150;
const NETWORK_IDLE_TIMEOUT =
  Number(process.env.NETWORK_IDLE_TIMEOUT_MS) || (IS_SERVERLESS ? 7000 : 20000);
const PAGE_GOTO_MAX_RETRIES = Number(process.env.PAGE_GOTO_MAX_RETRIES) || (IS_SERVERLESS ? 2 : 5);
const PAGE_GOTO_RETRY_DELAY_MS =
  Number(process.env.PAGE_GOTO_RETRY_DELAY_MS) || (IS_SERVERLESS ? 1000 : 5000);
const SCREENSHOT_RETRIES = Math.max(1, Number(process.env.SCREENSHOT_RETRIES) || 3);

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
  viewport = "desktop",
  ignoredSelectors = []
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= SCREENSHOT_RETRIES; attempt += 1) {
    const browser = await launchBrowser();

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

        await page.addStyleTag({ content: css }).catch(() => {});
      }

      let imageBuffer;
      try {
        imageBuffer = await page.screenshot({
          fullPage: true,
          animations: "disabled",
          caret: "hide"
        });
      } catch (fullPageError) {
        // Fallback for Chromium shell crashes on some GPU/canvas-heavy pages.
        imageBuffer = await page.screenshot({
          fullPage: false,
          animations: "disabled",
          caret: "hide"
        });
      }

      const html = await page.content();
      return { html, imageBuffer };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        /Target page, context or browser has been closed|ETXTBSY|Protocol error|CopyOutputResultSender/i.test(
          message
        );

      if (!retryable || attempt === SCREENSHOT_RETRIES) {
        break;
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }

  throw lastError;
}
