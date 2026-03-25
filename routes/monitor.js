import { randomUUID } from "crypto";
import path from "path";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync
} from "fs";
import { ensureDirSync } from "fs-extra";
import { Router } from "express";
import { fileURLToPath } from "url";

import { supabase } from "../lib/supabase.js";
import { compareDOM } from "../services/domDiffService.js";
import { crawlSitePages } from "../services/crawlService.js";
import { scanGitHubRepository } from "../services/githubRepoService.js";
import { captureScreenshot } from "../services/screenshotService.js";
import { compareImages } from "../services/visualDiffService.js";
import { generateReportPdf } from "../services/reportService.js";

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORAGE_ROOT = path.resolve(__dirname, "../storage");
const MAX_PAGES_PER_SCAN = Number(process.env.MAX_PAGES_PER_SCAN) || 0;
const PIXELMATCH_THRESHOLD = Number(process.env.PIXELMATCH_THRESHOLD) || 0.2;
const scanJobs = new Map();

function normalizeErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown scan failure.");

  if (raw.includes("Error code 521") || raw.includes("Web server is down")) {
    return "Supabase endpoint is unreachable (Cloudflare 521). Verify SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY and check Supabase project status.";
  }

  if (raw.toLowerCase().includes("<html")) {
    return "Received an unexpected HTML error response from an external service. Check Supabase and network connectivity.";
  }

  return raw;
}

function sanitizeSiteName(name = "") {
  return name.toLowerCase().trim().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizePageUrl(input) {
  const url = new URL(input);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function getPagePath(pageUrl) {
  const url = new URL(pageUrl);
  return url.pathname.replace(/\/+$/, "") || "/";
}

function getPageKey(pagePath) {
  if (pagePath === "/") {
    return "home";
  }

  const key = pagePath
    .split("/")
    .filter(Boolean)
    .map((segment) => sanitizeSiteName(segment))
    .filter(Boolean)
    .join("-");

  return key || "page";
}

function hashString(value = "") {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(16);
}

function getSiteStorageRoot(websiteId) {
  return path.join(STORAGE_ROOT, "sites", websiteId);
}

function getPageArtifactPaths({ websiteId, pagePath, timestamp }) {
  const pageKey = getPageKey(pagePath);
  const pageStem = `${pageKey}-${hashString(pagePath)}`;
  const siteRoot = getSiteStorageRoot(websiteId);

  return {
    pageId: pageStem,
    baselineImagePath: path.join(siteRoot, "baseline", `${pageStem}.png`),
    baselineHtmlPath: path.join(siteRoot, "baseline-html", `${pageStem}.html`),
    currentImagePath: path.join(siteRoot, "current", `${pageStem}-${timestamp}.png`),
    diffImagePath: path.join(siteRoot, "diff", `${pageStem}-${timestamp}.png`)
  };
}

function ensureStorageDirs(websiteId) {
  ensureDirSync(path.join(STORAGE_ROOT, "baseline"));
  ensureDirSync(path.join(STORAGE_ROOT, "current"));
  ensureDirSync(path.join(STORAGE_ROOT, "diff"));

  const siteRoot = getSiteStorageRoot(websiteId);
  ensureDirSync(path.join(siteRoot, "baseline"));
  ensureDirSync(path.join(siteRoot, "baseline-history"));
  ensureDirSync(path.join(siteRoot, "baseline-html"));
  ensureDirSync(path.join(siteRoot, "current"));
  ensureDirSync(path.join(siteRoot, "diff"));
}

function fileToPublicUrl(filePath) {
  const rel = path.relative(STORAGE_ROOT, filePath).replace(/\\/g, "/");

  try {
    const version = Math.floor(statSync(filePath).mtimeMs);
    return `/storage/${rel}?v=${version}`;
  } catch {
    return `/storage/${rel}`;
  }
}

async function getOrCreateWebsite(url) {
  const { data: existing, error: selectError } = await supabase
    .from("websites")
    .select("*")
    .eq("url", url)
    .maybeSingle();

  if (selectError) {
    throw new Error(selectError.message);
  }

  if (existing) {
    return existing;
  }

  const hostname = new URL(url).hostname;
  const siteKey = sanitizeSiteName(hostname);

  const { data: created, error: insertError } = await supabase
    .from("websites")
    .insert({
      url,
      site_key: siteKey,
      viewport: "desktop",
      threshold_percentage: 0.3,
      ignored_selectors: []
    })
    .select("*")
    .single();

  if (insertError) {
    throw new Error(insertError.message);
  }

  return created;
}

function getBaselineHtml({ website, pagePath, baselineHtmlPath }) {
  if (pagePath === "/" && website.baseline_html) {
    return website.baseline_html;
  }

  if (existsSync(baselineHtmlPath)) {
    return readFileSync(baselineHtmlPath, "utf8");
  }

  return "";
}

async function persistBaseline({ website, pagePath, baselineImagePath, baselineHtmlPath, currentImagePath, html }) {
  copyFileSync(currentImagePath, baselineImagePath);
  writeFileSync(baselineHtmlPath, html, "utf8");

  if (pagePath !== "/") {
    return;
  }

  const { error } = await supabase
    .from("websites")
    .update({
      baseline_image_path: baselineImagePath,
      baseline_html: html
    })
    .eq("id", website.id);

  if (error) {
    throw new Error(error.message);
  }
}

async function promoteCurrentToBaseline({
  website,
  pagePath,
  baselineImagePath,
  baselineHtmlPath,
  currentImagePath,
  html
}) {
  await persistBaseline({
    website,
    pagePath,
    baselineImagePath,
    baselineHtmlPath,
    currentImagePath,
    html
  });
}

function summarizePages(pageResults) {
  const totalPages = pageResults.length;
  const newPages = pageResults.filter((page) => page.baselineCreated).length;
  const pagesWithVisualChanges = pageResults.filter(
    (page) => page.visualRegression.mismatchPercentage > 0
  ).length;
  const pagesWithDomChanges = pageResults.filter((page) => page.domRegression.summary.total > 0).length;
  const highestVisualMismatch = Math.max(
    0,
    ...pageResults.map((page) => page.visualRegression.mismatchPercentage)
  );
  const overallStatus = pageResults.some((page) => page.visualRegression.status === "Critical")
    ? "Critical"
    : pageResults.some((page) => page.visualRegression.status === "Warning")
      ? "Warning"
      : "Pass";

  return {
    totalPages,
    newPages,
    pagesWithVisualChanges,
    pagesWithDomChanges,
    highestVisualMismatch,
    overallStatus
  };
}

function buildAggregateDomLog(pageResults) {
  return pageResults
    .flatMap((page) =>
      page.domRegression.diffLog.map((entry) => ({
        pagePath: page.path,
        ...entry
      }))
    )
    .slice(0, 200);
}

function updateJob(jobId, patch) {
  const existing = scanJobs.get(jobId);

  if (!existing) {
    return null;
  }

  const next = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  scanJobs.set(jobId, next);
  return next;
}

async function scanPage({ website, pageUrl, timestamp }) {
  const pagePath = getPagePath(pageUrl);
  const siteRoot = getSiteStorageRoot(website.id);
  const {
    pageId,
    baselineImagePath,
    baselineHtmlPath,
    currentImagePath,
    diffImagePath
  } = getPageArtifactPaths({
    websiteId: website.id,
    pagePath,
    timestamp
  });
  const baselineHtml = getBaselineHtml({
    website,
    pagePath,
    baselineHtmlPath
  });
  const baselineImage =
    pagePath === "/" && website.baseline_image_path ? website.baseline_image_path : baselineImagePath;

  const html = await captureScreenshot({
    url: pageUrl,
    outputPath: currentImagePath,
    viewport: website.viewport || "desktop",
    ignoredSelectors: Array.isArray(website.ignored_selectors) ? website.ignored_selectors : []
  });

  if (!existsSync(baselineImage) || !baselineHtml) {
    await persistBaseline({
      website,
      pagePath,
      baselineImagePath: baselineImage,
      baselineHtmlPath,
      currentImagePath,
      html
    });

    return {
      pageId,
      url: pageUrl,
      path: pagePath,
      baselineCreated: true,
      visualRegression: {
        mismatchPixels: 0,
        totalPixels: 0,
        mismatchPercentage: 0,
        status: "Pass",
        baselineImageUrl: fileToPublicUrl(baselineImage),
        currentImageUrl: fileToPublicUrl(currentImagePath),
        diffImageUrl: null
      },
      domRegression: {
        summary: {
          total: 0,
          added: 0,
          removed: 0,
          attributeChanged: 0,
          textChanged: 0,
          severity: "None"
        },
        changedSelectors: [],
        diffLog: []
      }
    };
  }

  const visualDiff = compareImages(baselineImage, currentImagePath, diffImagePath, {
    threshold: PIXELMATCH_THRESHOLD,
    mismatchThresholdPercentage: Number(website.threshold_percentage) || 0.3
  });
  const domChanges = compareDOM(baselineHtml, html);
  const baselineSnapshotPath = path.join(siteRoot, "baseline-history", `${pageId}-${timestamp}.png`);

  copyFileSync(baselineImage, baselineSnapshotPath);
  await promoteCurrentToBaseline({
    website,
    pagePath,
    baselineImagePath: baselineImage,
    baselineHtmlPath,
    currentImagePath,
    html
  });

  return {
    pageId,
    url: pageUrl,
    path: pagePath,
    baselineCreated: false,
    visualRegression: {
      ...visualDiff,
      baselineImageUrl: fileToPublicUrl(baselineSnapshotPath),
      currentImageUrl: fileToPublicUrl(currentImagePath),
      diffImageUrl: fileToPublicUrl(diffImagePath)
    },
    domRegression: domChanges
  };
}

async function runScanJob({ jobId, url, githubUrl }) {
  try {
    updateJob(jobId, {
      status: "running",
      progressPercentage: 5,
      message: "Preparing scan"
    });

    const normalizedRootUrl = normalizePageUrl(url);
    const website = await getOrCreateWebsite(normalizedRootUrl);
    const siteName = website.site_key || sanitizeSiteName(new URL(normalizedRootUrl).hostname);

    ensureStorageDirs(website.id);
    updateJob(jobId, {
      websiteId: website.id,
      siteName,
      progressPercentage: 15,
      message: "Crawling pages"
    });

    const discoveredPages = await crawlSitePages({
      startUrl: normalizedRootUrl,
      viewport: website.viewport || "desktop",
      maxPages: MAX_PAGES_PER_SCAN,
      onProgress: ({ currentUrl, visitedCount, discoveredCount, queuedCount }) => {
        updateJob(jobId, {
          currentPageUrl: currentUrl,
          message: `Crawling pages: visited ${visitedCount}, found ${discoveredCount}, queued ${queuedCount}`,
          progressPercentage: Math.min(29, Math.max(15, 15 + discoveredCount))
        });
      }
    });

    if (discoveredPages.length === 0) {
      throw new Error("No crawlable pages were found for this site.");
    }

    const timestamp = Date.now();
    const pageResults = [];
    const totalPages = discoveredPages.length;

    updateJob(jobId, {
      totalPages,
      completedPages: 0,
      progressPercentage: 30,
      message: `Found ${totalPages} page(s). Starting page scans`
    });

    for (let index = 0; index < discoveredPages.length; index += 1) {
      const pageUrl = discoveredPages[index];
      updateJob(jobId, {
        currentPageUrl: pageUrl,
        message: `Scanning ${index + 1} of ${totalPages}: ${pageUrl}`,
        progressPercentage: Math.min(90, Math.round(30 + ((index / totalPages) * 60)))
      });

      const pageResult = await scanPage({
        website,
        pageUrl,
        timestamp
      });

      pageResults.push(pageResult);
      updateJob(jobId, {
        completedPages: index + 1,
        progressPercentage: Math.min(90, Math.round(30 + (((index + 1) / totalPages) * 60)))
      });
    }

    const summary = summarizePages(pageResults);
    const rootPage = pageResults.find((page) => page.path === "/") ?? pageResults[0];
    const aggregateDomLog = buildAggregateDomLog(pageResults);
    let codeRegression = null;

    if (githubUrl) {
      updateJob(jobId, {
        progressPercentage: 93,
        message: "Checking GitHub repository changes"
      });

      codeRegression = await scanGitHubRepository({
        githubUrl,
        storageRoot: STORAGE_ROOT
      });
    }

    updateJob(jobId, {
      progressPercentage: 95,
      message: "Saving scan result"
    });

    const responsePayload = {
      baselineCreated: summary.newPages > 0,
      message:
        summary.newPages > 0
          ? `Baseline created for ${summary.newPages} page(s). Run another scan to detect regressions on those pages.`
          : `Scanned ${summary.totalPages} page(s) across the site.`,
      websiteId: website.id,
      siteUrl: normalizedRootUrl,
      siteName,
      githubUrl: githubUrl || null,
      scanId: null,
      summary,
      visualRegression: rootPage.visualRegression,
      domRegression: rootPage.domRegression,
      pageResults,
      codeRegression
    };

    const { data: scanRow, error: scanInsertError } = await supabase
      .from("scans")
      .insert({
        website_id: website.id,
        baseline_created: responsePayload.baselineCreated,
        visual_mismatch_percentage: summary.highestVisualMismatch,
        visual_status: summary.overallStatus,
        visual_baseline_image_url: rootPage.visualRegression.baselineImageUrl,
        visual_current_image_url: rootPage.visualRegression.currentImageUrl,
        visual_diff_image_url: rootPage.visualRegression.diffImageUrl,
        report_payload: responsePayload,
        dom_summary: {
          ...rootPage.domRegression.summary,
          totalPages: summary.totalPages,
          newPages: summary.newPages,
          pagesWithVisualChanges: summary.pagesWithVisualChanges,
          pagesWithDomChanges: summary.pagesWithDomChanges
        },
        dom_changed_selectors: rootPage.domRegression.changedSelectors,
        dom_diff_log: aggregateDomLog
      })
      .select("id")
      .single();

    if (scanInsertError) {
      throw new Error(scanInsertError.message);
    }

    updateJob(jobId, {
      status: "completed",
      progressPercentage: 100,
      message: "Scan completed",
      result: {
        ...responsePayload,
        scanId: scanRow?.id ?? null
      }
    });
  } catch (error) {
    const normalizedError = normalizeErrorMessage(error);
    updateJob(jobId, {
      status: "failed",
      message: "Scan failed",
      error: normalizedError
    });
  }
}

router.get("/history/:websiteId", async (req, res) => {
  const { websiteId } = req.params;

  const { data, error } = await supabase
    .from("scans")
    .select("*")
    .eq("website_id", websiteId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json({ scans: data ?? [] });
});

router.post("/report", async (req, res) => {
  try {
    const { result } = req.body ?? {};

    if (!result) {
      return res.status(400).json({ error: "Missing scan result payload." });
    }

    const pdfBuffer = await generateReportPdf(result);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=scan-report.pdf");
    return res.send(pdfBuffer);
  } catch (error) {
    console.error("Failed to generate report:", error);
    return res.status(500).json({ error: error.message || "Failed to generate report." });
  }
});

router.get("/report/:scanId", async (req, res) => {
  try {
    const { scanId } = req.params;

    const { data, error } = await supabase
      .from("scans")
      .select("report_payload")
      .eq("id", scanId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!data?.report_payload || Object.keys(data.report_payload).length === 0) {
      return res.status(404).json({ error: "Report payload not found for this scan." });
    }

    const pdfBuffer = await generateReportPdf(data.report_payload);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=scan-report-${scanId}.pdf`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error("Failed to generate report:", error);
    return res.status(500).json({ error: error.message || "Failed to generate report." });
  }
});

router.get("/jobs/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = scanJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: "Scan job not found." });
  }

  return res.json(job);
});

router.post("/", async (req, res) => {
  const { url, githubUrl } = req.body ?? {};

  try {
    normalizePageUrl(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL." });
  }

  const jobId = randomUUID();
  const job = {
    jobId,
    status: "queued",
    progressPercentage: 0,
    message: "Queued",
    websiteId: null,
    siteName: null,
    totalPages: 0,
    completedPages: 0,
    currentPageUrl: null,
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  scanJobs.set(jobId, job);

  void runScanJob({
    jobId,
    url,
    githubUrl
  });

  return res.status(202).json({ jobId });
});

export default router;
