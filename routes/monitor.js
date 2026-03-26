import { randomUUID } from "crypto";
import { Router } from "express";

import { supabase } from "../lib/supabase.js";
import { crawlSitePages } from "../services/crawlService.js";
import { compareDOM } from "../services/domDiffService.js";
import { scanGitHubRepository } from "../services/githubRepoService.js";
import { generateReportPdf } from "../services/reportService.js";
import { captureScreenshot } from "../services/screenshotService.js";
import { compareImages } from "../services/visualDiffService.js";

const router = Router();
const MAX_PAGES_PER_SCAN =
  Number(process.env.MAX_PAGES_PER_SCAN) || 0;
const PIXELMATCH_THRESHOLD = Number(process.env.PIXELMATCH_THRESHOLD) || 0.2;
const SUPABASE_SCAN_BUCKET = process.env.SUPABASE_SCAN_BUCKET || "scan-artifacts";
const STORAGE_UPLOAD_RETRIES = Math.max(1, Number(process.env.STORAGE_UPLOAD_RETRIES) || 4);
const STORAGE_UPLOAD_RETRY_DELAY_MS = Math.max(
  100,
  Number(process.env.STORAGE_UPLOAD_RETRY_DELAY_MS) || 1200
);
const scanJobs = new Map();
const JOBS_TABLE = "scan_jobs";

let scanBucketReadyPromise = null;

function isServerlessRuntime() {
  return (
    process.env.VERCEL === "1" ||
    Boolean(process.env.AWS_REGION) ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME)
  );
}

function normalizeErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown scan failure.");

  if (raw.includes("Error code 521") || raw.includes("Web server is down")) {
    return "Supabase endpoint is unreachable (Cloudflare 521). Verify SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY and check Supabase project status.";
  }

  if (raw.toLowerCase().includes("<html")) {
    return "Received an unexpected HTML error response from an external service. Check Supabase and network connectivity.";
  }

  if (/page crashed|target page, context or browser has been closed/i.test(raw)) {
    return "Browser crashed while scanning a page. The scan continued where possible; retry for this site or reduce page scope.";
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

function getPageArtifactKeys({ websiteId, pagePath, timestamp }) {
  const pageKey = getPageKey(pagePath);
  const pageStem = `${pageKey}-${hashString(pagePath)}`;

  return {
    pageId: pageStem,
    baselineImageKey: `sites/${websiteId}/baseline/${pageStem}.png`,
    currentImageKey: `sites/${websiteId}/current/${pageStem}-${timestamp}.png`,
    diffImageKey: `sites/${websiteId}/diff/${pageStem}-${timestamp}.png`,
    baselineSnapshotKey: `sites/${websiteId}/baseline-history/${pageStem}-${timestamp}.png`
  };
}

function toPublicStorageUrl(objectKey) {
  const { data } = supabase.storage.from(SUPABASE_SCAN_BUCKET).getPublicUrl(objectKey);
  return data.publicUrl;
}

function isSupabaseObjectKey(value) {
  if (!value || typeof value !== "string") {
    return false;
  }

  if (/^https?:\/\//i.test(value)) {
    return false;
  }

  if (value.startsWith("/storage/")) {
    return false;
  }

  if (/^[a-zA-Z]:\\/.test(value)) {
    return false;
  }

  return true;
}

async function ensureScanBucket() {
  if (!scanBucketReadyPromise) {
    scanBucketReadyPromise = (async () => {
      const { error: createError } = await supabase.storage.createBucket(SUPABASE_SCAN_BUCKET, {
        public: true
      });

      if (!createError) {
        return;
      }

      const createMessage = String(createError.message || "");
      const alreadyExists = /already exists|duplicate|409/i.test(createMessage);
      if (alreadyExists) {
        return;
      }

      // Some projects return transient 500s for bucket metadata APIs.
      // Verify bucket usability directly before failing.
      if (/internal server error|500/i.test(createMessage)) {
        const { error: verifyError } = await supabase
          .storage
          .from(SUPABASE_SCAN_BUCKET)
          .list("", { limit: 1 });

        if (!verifyError) {
          return;
        }
      }

      throw new Error(`Failed to initialize bucket '${SUPABASE_SCAN_BUCKET}': ${createMessage}`);
    })();
  }

  return scanBucketReadyPromise;
}

async function uploadArtifact(objectKey, buffer, contentType) {
  await ensureScanBucket();
  let lastError = null;

  for (let attempt = 1; attempt <= STORAGE_UPLOAD_RETRIES; attempt += 1) {
    const { error } = await supabase.storage
      .from(SUPABASE_SCAN_BUCKET)
      .upload(objectKey, buffer, { contentType, upsert: true });

    if (!error) {
      return toPublicStorageUrl(objectKey);
    }

    lastError = error;
    const rawMessage = String(error.message || "");
    const transient =
      /bad gateway|gateway|502|503|504|timeout|temporar/i.test(rawMessage);

    if (!transient || attempt === STORAGE_UPLOAD_RETRIES) {
      break;
    }

    const backoffMs = STORAGE_UPLOAD_RETRY_DELAY_MS * attempt;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }

  const sizeMb = (buffer.length / (1024 * 1024)).toFixed(2);
  throw new Error(
    `Failed to upload '${objectKey}' to Supabase Storage after ${STORAGE_UPLOAD_RETRIES} attempt(s). ` +
      `Size=${sizeMb}MB. Last error: ${lastError?.message || "Unknown upload error"}`
  );
}

async function downloadArtifact(objectKey) {
  await ensureScanBucket();
  const { data, error } = await supabase.storage.from(SUPABASE_SCAN_BUCKET).download(objectKey);

  if (error) {
    throw new Error(`Failed to download '${objectKey}' from Supabase Storage: ${error.message}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
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

async function getPageBaseline({ website, pagePath }) {
  const { data, error } = await supabase
    .from("page_baselines")
    .select("*")
    .eq("website_id", website.id)
    .eq("page_path", pagePath)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (data) {
    return data;
  }

  if (
    pagePath === "/" &&
    website.baseline_html &&
    website.baseline_image_path &&
    isSupabaseObjectKey(website.baseline_image_path)
  ) {
    return {
      website_id: website.id,
      page_path: pagePath,
      baseline_image_path: website.baseline_image_path,
      baseline_html: website.baseline_html
    };
  }

  return null;
}

async function upsertPageBaseline({ websiteId, pagePath, baselineImageKey, html }) {
  const { error } = await supabase.from("page_baselines").upsert(
    {
      website_id: websiteId,
      page_path: pagePath,
      baseline_image_path: baselineImageKey,
      baseline_html: html,
      updated_at: new Date().toISOString()
    },
    {
      onConflict: "website_id,page_path"
    }
  );

  if (error) {
    throw new Error(error.message);
  }
}

async function persistBaseline({ website, pagePath, baselineImageKey, currentImageBuffer, html }) {
  const baselineImageUrl = await uploadArtifact(baselineImageKey, currentImageBuffer, "image/png");

  await upsertPageBaseline({
    websiteId: website.id,
    pagePath,
    baselineImageKey,
    html
  });

  if (pagePath !== "/") {
    return baselineImageUrl;
  }

  const { error } = await supabase
    .from("websites")
    .update({
      baseline_image_path: baselineImageKey,
      baseline_html: html
    })
    .eq("id", website.id);

  if (error) {
    throw new Error(error.message);
  }

  return baselineImageUrl;
}

async function promoteCurrentToBaseline({ website, pagePath, baselineImageKey, currentImageBuffer, html }) {
  await persistBaseline({
    website,
    pagePath,
    baselineImageKey,
    currentImageBuffer,
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

function buildFailedPageResult({ pageUrl, error }) {
  const pagePath = getPagePath(pageUrl);
  const message = error instanceof Error ? error.message : String(error ?? "Page scan failed.");

  return {
    pageId: `failed-${hashString(pagePath)}`,
    url: pageUrl,
    path: pagePath,
    baselineCreated: false,
    visualRegression: {
      mismatchPixels: 0,
      totalPixels: 0,
      mismatchPercentage: 0,
      status: "Warning",
      baselineImageUrl: "",
      currentImageUrl: "",
      diffImageUrl: null,
      error: message
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
      diffLog: [],
      error: message
    }
  };
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
  void persistJob(next).catch((error) => {
    console.error("Failed to persist scan job update:", error);
  });
  return next;
}

function toDbJobPayload(job) {
  return {
    job_id: job.jobId,
    status: job.status,
    progress_percentage: job.progressPercentage,
    message: job.message,
    website_id: job.websiteId,
    site_name: job.siteName,
    total_pages: job.totalPages,
    completed_pages: job.completedPages,
    current_page_url: job.currentPageUrl,
    result: job.result,
    error: job.error,
    created_at: job.createdAt,
    updated_at: job.updatedAt
  };
}

function fromDbJobPayload(row) {
  return {
    jobId: row.job_id,
    status: row.status,
    progressPercentage: row.progress_percentage,
    message: row.message,
    websiteId: row.website_id,
    siteName: row.site_name,
    totalPages: row.total_pages,
    completedPages: row.completed_pages,
    currentPageUrl: row.current_page_url,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function createJobRecord(job) {
  const { error } = await supabase.from(JOBS_TABLE).insert(toDbJobPayload(job));
  if (error) {
    throw new Error(error.message);
  }
}

async function persistJob(job) {
  const { error } = await supabase
    .from(JOBS_TABLE)
    .upsert(toDbJobPayload(job), { onConflict: "job_id" });
  if (error) {
    throw new Error(error.message);
  }
}

async function fetchJobRecord(jobId) {
  const { data, error } = await supabase
    .from(JOBS_TABLE)
    .select("*")
    .eq("job_id", jobId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? fromDbJobPayload(data) : null;
}

async function scanPage({ website, pageUrl, timestamp }) {
  const pagePath = getPagePath(pageUrl);
  const {
    pageId,
    baselineImageKey,
    currentImageKey,
    diffImageKey,
    baselineSnapshotKey
  } = getPageArtifactKeys({
    websiteId: website.id,
    pagePath,
    timestamp
  });

  const { html, imageBuffer } = await captureScreenshot({
    url: pageUrl,
    viewport: website.viewport || "desktop",
    ignoredSelectors: Array.isArray(website.ignored_selectors) ? website.ignored_selectors : []
  });

  const currentImageUrl = await uploadArtifact(currentImageKey, imageBuffer, "image/png");
  const baselineRecord = await getPageBaseline({ website, pagePath });
  const baselineHtml = baselineRecord?.baseline_html || "";
  const baselineImageObjectKey = isSupabaseObjectKey(baselineRecord?.baseline_image_path)
    ? baselineRecord.baseline_image_path
    : null;

  if (!baselineImageObjectKey || !baselineHtml) {
    const baselineImageUrl = await persistBaseline({
      website,
      pagePath,
      baselineImageKey,
      currentImageBuffer: imageBuffer,
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
        baselineImageUrl,
        currentImageUrl,
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

  let baselineBuffer;
  try {
    baselineBuffer = await downloadArtifact(baselineImageObjectKey);
  } catch {
    const baselineImageUrl = await persistBaseline({
      website,
      pagePath,
      baselineImageKey,
      currentImageBuffer: imageBuffer,
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
        baselineImageUrl,
        currentImageUrl,
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

  const baselineImageUrl = await uploadArtifact(baselineSnapshotKey, baselineBuffer, "image/png");
  const visualDiff = compareImages(baselineBuffer, imageBuffer, {
    threshold: PIXELMATCH_THRESHOLD,
    mismatchThresholdPercentage: Number(website.threshold_percentage) || 0.3
  });
  const diffImageUrl = await uploadArtifact(diffImageKey, visualDiff.diffBuffer, "image/png");
  const domChanges = compareDOM(baselineHtml, html);

  await promoteCurrentToBaseline({
    website,
    pagePath,
    baselineImageKey,
    currentImageBuffer: imageBuffer,
    html
  });

  return {
    pageId,
    url: pageUrl,
    path: pagePath,
    baselineCreated: false,
    visualRegression: {
      mismatchPixels: visualDiff.mismatchPixels,
      totalPixels: visualDiff.totalPixels,
      mismatchPercentage: visualDiff.mismatchPercentage,
      status: visualDiff.status,
      baselineImageUrl,
      currentImageUrl,
      diffImageUrl
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

    await ensureScanBucket();

    const normalizedRootUrl = normalizePageUrl(url);
    const website = await getOrCreateWebsite(normalizedRootUrl);
    const siteName = website.site_key || sanitizeSiteName(new URL(normalizedRootUrl).hostname);

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

    const pagesToScan =
      discoveredPages.length > 0 ? discoveredPages : [normalizedRootUrl];

    const timestamp = Date.now();
    const pageResults = [];
    const totalPages = pagesToScan.length;

    updateJob(jobId, {
      totalPages,
      completedPages: 0,
      progressPercentage: 30,
      message: `Found ${totalPages} page(s). Starting page scans`
    });

    for (let index = 0; index < pagesToScan.length; index += 1) {
      const pageUrl = pagesToScan[index];
      updateJob(jobId, {
        currentPageUrl: pageUrl,
        message: `Scanning ${index + 1} of ${totalPages}: ${pageUrl}`,
        progressPercentage: Math.min(90, Math.round(30 + ((index / totalPages) * 60)))
      });

      let pageResult;
      try {
        pageResult = await scanPage({
          website,
          pageUrl,
          timestamp
        });
      } catch (pageError) {
        pageResult = buildFailedPageResult({ pageUrl, error: pageError });
        updateJob(jobId, {
          message: `Skipped failed page ${index + 1}/${totalPages}: ${pageUrl}`
        });
      }

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

      codeRegression = await scanGitHubRepository({ githubUrl });
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

router.get("/jobs/:jobId", async (req, res) => {
  const jobId = req.params.jobId;
  const memoryJob = scanJobs.get(jobId);

  try {
    const persistedJob = memoryJob ?? (await fetchJobRecord(jobId));
    if (!persistedJob) {
      return res.status(404).json({ error: "Scan job not found." });
    }
    scanJobs.set(jobId, persistedJob);

    const shouldRunOnPoll =
      isServerlessRuntime() &&
      persistedJob.status === "queued" &&
      persistedJob.result &&
      typeof persistedJob.result === "object" &&
      persistedJob.result.request &&
      typeof persistedJob.result.request === "object";

    if (shouldRunOnPoll) {
      const requestPayload = persistedJob.result.request;
      await runScanJob({
        jobId,
        url: requestPayload.url,
        githubUrl: requestPayload.githubUrl
      });
      const latest = scanJobs.get(jobId) ?? (await fetchJobRecord(jobId));
      if (!latest) {
        return res.status(404).json({ error: "Scan job not found." });
      }
      return res.json(latest);
    }

    return res.json(persistedJob);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to fetch scan job." });
  }
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
    result: {
      request: {
        url,
        githubUrl: githubUrl || null
      }
    },
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  scanJobs.set(jobId, job);
  try {
    await createJobRecord(job);
  } catch (error) {
    return res.status(500).json({ error: `Failed to create scan job: ${error.message}` });
  }

  if (!isServerlessRuntime()) {
    void runScanJob({
      jobId,
      url,
      githubUrl
    });
  } else {
    updateJob(jobId, {
      message: "Queued. Scan will start on first status poll.",
      progressPercentage: 1
    });
  }

  return res.status(202).json({ jobId });
});

export default router;
