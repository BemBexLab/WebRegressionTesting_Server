import { launchBrowser } from "./browserService.js";

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function resolveImageUrl(path, baseUrl) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function buildReportHtml(result) {
  const summary = result?.summary ?? {};
  const code = result?.codeRegression ?? null;
  const pageRows = (result?.pageResults ?? [])
    .filter((page) => (page.domRegression?.summary?.total ?? 0) > 0)
    .map((page) => {
      const dom = page.domRegression?.summary ?? {};
      const changes = (page.domRegression?.diffLog ?? [])
        .map((entry) => {
          const selector = escapeHtml(entry.selector ?? "");
          const type = escapeHtml(entry.type ?? "");
          const before = entry.beforeHtml || escapeHtml(entry.oldHtml ?? "");
          const after = entry.afterHtml || escapeHtml(entry.newHtml ?? "");
          return `
            <div class="dom-change">
              <div class="dom-meta">
                <span class="pill">${type.replace(/_/g, " ")}</span>
                <span class="selector">${selector}</span>
              </div>
              <table class="dom-table">
                <thead>
                  <tr>
                    <th>Before</th>
                    <th>After</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <pre class="dom-code">${before || "<span class='small'>No before HTML</span>"}</pre>
                    </td>
                    <td>
                      <pre class="dom-code">${after || "<span class='small'>No after HTML</span>"}</pre>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          `;
        })
        .join("");
      return `
        <tr>
          <td>${escapeHtml(page.path)}</td>
          <td>${escapeHtml(page.url)}</td>
          <td>${escapeHtml(page.visualRegression?.status)}</td>
          <td>${formatNumber(page.visualRegression?.mismatchPercentage)}</td>
          <td>${formatNumber(dom.total)}</td>
          <td>${escapeHtml(dom.severity)}</td>
        </tr>
        <tr>
          <td colspan="6">
            ${
              changes
                ? `<div class="dom-changes">${changes}</div>`
                : `<div class="small">No DOM changes captured for this page.</div>`
            }
          </td>
        </tr>
      `;
    })
    .join("");

  const codeRows = code
    ? code.changedFiles
        .map((file) => {
          return `
            <tr>
              <td>${escapeHtml(file.status)}</td>
              <td>${escapeHtml(file.path)}</td>
              <td>${formatNumber(file.additions)}</td>
              <td>${formatNumber(file.deletions)}</td>
              <td>${formatNumber(file.changes)}</td>
            </tr>
          `;
        })
        .join("")
    : "";

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Scan Report</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 32px; color: #0f172a; }
          h1 { font-size: 22px; margin-bottom: 8px; }
          h2 { font-size: 16px; margin-top: 28px; }
          .meta { font-size: 12px; color: #475569; margin-bottom: 18px; }
          .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
          .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; }
          .label { font-size: 11px; text-transform: uppercase; color: #64748b; }
          .value { font-size: 15px; font-weight: 600; margin-top: 4px; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th, td { border: 1px solid #e2e8f0; padding: 8px; font-size: 12px; text-align: left; vertical-align: top; }
          th { background: #f8fafc; }
          .dom-changes { display: flex; flex-direction: column; gap: 14px; }
          .dom-change { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; }
          .dom-meta { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
          .pill { font-size: 10px; text-transform: uppercase; padding: 2px 6px; border-radius: 999px; background: #f1f5f9; color: #0f172a; }
          .selector { font-size: 11px; color: #475569; }
          .dom-table { width: 100%; border-collapse: collapse; }
          .dom-table th, .dom-table td { border: 1px solid #e2e8f0; padding: 6px; font-size: 11px; text-align: left; vertical-align: top; }
          .dom-table th { background: #f8fafc; text-transform: uppercase; color: #64748b; }
          .dom-code { background: #0f172a; color: #e2e8f0; padding: 8px; border-radius: 6px; font-size: 10px; white-space: pre-wrap; word-break: break-word; }
          .diff-add { background: rgba(34, 197, 94, 0.2); }
          .diff-del { background: rgba(239, 68, 68, 0.2); text-decoration: line-through; }
          .page-row { page-break-inside: avoid; }
          .small { font-size: 11px; color: #64748b; }
        </style>
      </head>
      <body>
        <h1>Website Regression Scan Report</h1>
        <div class="meta">
          Site URL: ${escapeHtml(result?.siteUrl ?? "")}<br/>
          Site Name: ${escapeHtml(result?.siteName ?? "")}<br/>
          Scan ID: ${escapeHtml(result?.scanId ?? "N/A")}<br/>
          Generated: ${escapeHtml(new Date().toLocaleString())}
        </div>

        <h2>Scan Summary</h2>
        <div class="grid">
          <div class="card"><div class="label">Pages</div><div class="value">${formatNumber(summary.totalPages)}</div></div>
          <div class="card"><div class="label">New Pages</div><div class="value">${formatNumber(summary.newPages)}</div></div>
          <div class="card"><div class="label">Visual Changes</div><div class="value">${formatNumber(summary.pagesWithVisualChanges)}</div></div>
          <div class="card"><div class="label">DOM Changes</div><div class="value">${formatNumber(summary.pagesWithDomChanges)}</div></div>
          <div class="card"><div class="label">Max Mismatch %</div><div class="value">${formatNumber(summary.highestVisualMismatch)}</div></div>
          <div class="card"><div class="label">Overall Status</div><div class="value">${escapeHtml(summary.overallStatus)}</div></div>
        </div>

        <h2>Page Results</h2>
        <table>
              <thead>
                <tr>
                  <th>Path</th>
                  <th>URL</th>
                  <th>Visual Status</th>
                  <th>Mismatch %</th>
                  <th>DOM Total</th>
                  <th>DOM Severity</th>
                </tr>
              </thead>
              <tbody>
                ${pageRows || `<tr><td colspan="6" class="small">No pages recorded.</td></tr>`}
              </tbody>
        </table>

        ${
          code
            ? `
            <h2>GitHub Codebase Changes</h2>
            <div class="meta">
              Repository: ${escapeHtml(code.repositoryUrl)}<br/>
              Branch: ${escapeHtml(code.branch)}<br/>
              Commit: ${escapeHtml(code.currentCommitSha?.slice(0, 7) ?? "")}
            </div>
            <div class="grid">
              <div class="card"><div class="label">Changed Files</div><div class="value">${formatNumber(code.summary?.totalChangedFiles)}</div></div>
              <div class="card"><div class="label">Added</div><div class="value">${formatNumber(code.summary?.added)}</div></div>
              <div class="card"><div class="label">Removed</div><div class="value">${formatNumber(code.summary?.removed)}</div></div>
              <div class="card"><div class="label">Modified</div><div class="value">${formatNumber(code.summary?.modified)}</div></div>
              <div class="card"><div class="label">Renamed</div><div class="value">${formatNumber(code.summary?.renamed)}</div></div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Path</th>
                  <th>Additions</th>
                  <th>Deletions</th>
                  <th>Changes</th>
                </tr>
              </thead>
              <tbody>
                ${codeRows || `<tr><td colspan="5" class="small">No code changes detected.</td></tr>`}
              </tbody>
            </table>
          `
            : ""
        }
      </body>
    </html>
  `;
}

export async function generateReportPdf(result) {
  const html = buildReportHtml(result);
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" }
    });

    return pdfBuffer;
  } finally {
    await browser.close();
  }
}
