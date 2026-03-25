import { chromium } from "playwright";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 }
};
const PAGE_GOTO_TIMEOUT = Number(process.env.PAGE_GOTO_TIMEOUT_MS) || 45000;
const POST_LOAD_DELAY = Number(process.env.POST_LOAD_DELAY_MS) || 1000;
const PAGE_GOTO_MAX_RETRIES = Number(process.env.PAGE_GOTO_MAX_RETRIES) || 5;
const PAGE_GOTO_RETRY_DELAY_MS = Number(process.env.PAGE_GOTO_RETRY_DELAY_MS) || 5000;
const NETWORK_IDLE_TIMEOUT = Number(process.env.NETWORK_IDLE_TIMEOUT_MS) || 20000;

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

export async function crawlSitePages({
  startUrl,
  viewport = "desktop",
  maxPages = 0,
  onProgress
}) {
  const initialUrl = normalizePageUrl(startUrl);
  const origin = new URL(initialUrl).origin;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport] ?? VIEWPORTS.desktop
  });

  const queue = [initialUrl];
  const queued = new Set(queue);
  const visited = new Set();
  const pages = [];

  try {
    while (queue.length > 0 && (maxPages <= 0 || pages.length < maxPages)) {
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
        await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT }).catch(() => {});
        await page.waitForTimeout(POST_LOAD_DELAY);
        const resolvedUrl = normalizePageUrl(page.url());

        if (!shouldVisit(new URL(resolvedUrl), origin)) {
          continue;
        }

        pages.push(resolvedUrl);

        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll("a[href]"), (anchor) => anchor.href)
        );

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
        if (pages.length === 0) {
          throw error;
        }
      } finally {
        await page.close();
      }
    }

    return [...new Set(pages)];
  } finally {
    await context.close();
    await browser.close();
  }
}
