import { launchBrowser } from "./browserService.js";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 }
};
const IS_SERVERLESS =
  process.env.VERCEL === "1" || Boolean(process.env.AWS_REGION) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const PAGE_GOTO_TIMEOUT =
  Number(process.env.CRAWL_PAGE_GOTO_TIMEOUT_MS) || (IS_SERVERLESS ? 10000 : 15000);
const POST_LOAD_DELAY = Number(process.env.CRAWL_POST_LOAD_DELAY_MS) || (IS_SERVERLESS ? 200 : 500);
const PAGE_GOTO_MAX_RETRIES =
  Number(process.env.CRAWL_PAGE_GOTO_MAX_RETRIES) || (IS_SERVERLESS ? 1 : 2);
const PAGE_GOTO_RETRY_DELAY_MS =
  Number(process.env.CRAWL_PAGE_GOTO_RETRY_DELAY_MS) || (IS_SERVERLESS ? 500 : 1000);
const NETWORK_IDLE_TIMEOUT =
  Number(process.env.CRAWL_NETWORK_IDLE_TIMEOUT_MS) || (IS_SERVERLESS ? 3000 : 5000);
const CRAWL_LOAD_TIMEOUT_MS =
  Number(process.env.CRAWL_LOAD_TIMEOUT_MS) || (IS_SERVERLESS ? 20000 : 30000);
const CRAWL_MAX_LINKS_PER_PAGE = Number(process.env.CRAWL_MAX_LINKS_PER_PAGE) || 0;
const CRAWL_ABSOLUTE_MAX_PAGES = Number(process.env.CRAWL_ABSOLUTE_MAX_PAGES) || 0;
const CRAWL_SCROLL_STEP_DELAY_MS = Number(process.env.CRAWL_SCROLL_STEP_DELAY_MS) || 120;

const SKIP_FILE_EXTENSIONS =
  /\.(?:7z|avi|bmp|css|csv|doc|docx|eot|gif|ico|jpeg|jpg|js|json|mov|mp3|mp4|pdf|png|ppt|pptx|rar|svg|tar|txt|webm|webp|woff2?|xls|xlsx|xml|zip)$/i;

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

function normalizePageUrl(input) {
  const url = new URL(input);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function shouldVisit(url, origin) {
  if (!["http:", "https:"].includes(url.protocol)) {
    return false;
  }

  if (url.origin !== origin) {
    return false;
  }

  return !SKIP_FILE_EXTENSIONS.test(url.pathname);
}

async function scrollEntirePage(page) {
  await page.evaluate(async (stepDelay) => {
    const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const step = Math.max(window.innerHeight || 800, 300);
    let previousHeight = 0;
    let stableIterations = 0;

    while (stableIterations < 3) {
      const currentHeight = Math.max(
        document.body?.scrollHeight ?? 0,
        document.documentElement?.scrollHeight ?? 0
      );

      if (currentHeight <= previousHeight) {
        stableIterations += 1;
      } else {
        stableIterations = 0;
        previousHeight = currentHeight;
      }

      for (let y = window.scrollY; y < currentHeight; y += step) {
        window.scrollTo(0, y);
        await wait(stepDelay);
      }

      await wait(stepDelay * 2);
    }

    window.scrollTo(0, 0);
  }, CRAWL_SCROLL_STEP_DELAY_MS);
}

export async function crawlSitePages({
  startUrl,
  viewport = "desktop",
  maxPages = 0,
  onProgress
}) {
  const initialUrl = normalizePageUrl(startUrl);
  const origin = new URL(initialUrl).origin;
  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport] ?? VIEWPORTS.desktop
  });

  const queue = [initialUrl];
  const queued = new Set(queue);
  const visited = new Set();
  const pages = [];

  let effectiveMaxPages = maxPages > 0 ? maxPages : Number.POSITIVE_INFINITY;
  if (CRAWL_ABSOLUTE_MAX_PAGES > 0) {
    effectiveMaxPages = Math.min(effectiveMaxPages, CRAWL_ABSOLUTE_MAX_PAGES);
  }

  try {
    while (queue.length > 0 && pages.length < effectiveMaxPages) {
      const nextUrl = queue.shift();

      if (!nextUrl || visited.has(nextUrl)) {
        continue;
      }

      visited.add(nextUrl);
      onProgress?.({
        phase: "crawl",
        currentUrl: nextUrl,
        visitedCount: visited.size,
        discoveredCount: pages.length,
        queuedCount: queue.length
      });
      const page = await context.newPage();

      try {
        await gotoWithRetry(page, nextUrl);
        await page.waitForLoadState("load", { timeout: CRAWL_LOAD_TIMEOUT_MS }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT }).catch(() => {});
        await page.waitForTimeout(POST_LOAD_DELAY);
        await scrollEntirePage(page).catch(() => {});
        const resolvedUrl = normalizePageUrl(page.url());

        if (!shouldVisit(new URL(resolvedUrl), origin)) {
          continue;
        }

        pages.push(resolvedUrl);

        const links = await page.evaluate((maxLinks) => {
          const hrefs = Array.from(document.querySelectorAll("a[href]"), (anchor) => anchor.href);
          if (!maxLinks || maxLinks <= 0) {
            return hrefs;
          }
          return hrefs.slice(0, maxLinks);
        }, CRAWL_MAX_LINKS_PER_PAGE);

        for (const href of links) {
          try {
            const normalized = normalizePageUrl(href);
            const parsed = new URL(normalized);

            if (!shouldVisit(parsed, origin) || visited.has(normalized) || queued.has(normalized)) {
              continue;
            }

            queued.add(normalized);
            queue.push(normalized);
          } catch {
            continue;
          }
        }
      } catch (error) {
        // Do not abort full crawl on one crashing page in production.
        // Caller can still scan discovered URLs or fallback to the root URL.
        onProgress?.({
          phase: "crawl",
          currentUrl: nextUrl,
          visitedCount: visited.size,
          discoveredCount: pages.length,
          queuedCount: queue.length,
          error: error instanceof Error ? error.message : String(error ?? "Crawl page failed")
        });
      } finally {
        await page.close().catch(() => {});
      }
    }

    const discovered = [...new Set(pages)];
    if (discovered.length === 0) {
      return [initialUrl];
    }
    return discovered;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
