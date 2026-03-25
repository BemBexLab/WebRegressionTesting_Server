import { load } from "cheerio";
import { createTwoFilesPatch, diffWords } from "diff";
import { cleanHtml } from "../utils/cleanHtml.js";

const DYNAMIC_ATTRIBUTES = new Set([
  "nonce",
  "integrity",
  "data-reactroot",
  "class",
  "style",
  "srcset",
  "sizes",
  "loading",
  "decoding",
  "fetchpriority"
]);

const MAX_UNIFIED_DIFF_CHARS = Number(process.env.DOM_DIFF_MAX_CHARS) || 20000;
const MAX_SNIPPET_CHARS = Number(process.env.DOM_SNIPPET_MAX_CHARS) || 4000;

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function trimSnippet(value = "") {
  if (!value || value.length <= MAX_SNIPPET_CHARS) return value;
  return `${value.slice(0, MAX_SNIPPET_CHARS)}\n...snippet truncated (${value.length} chars)`;
}

function buildHighlightedDiff(before = "", after = "") {
  const parts = diffWords(before, after);
  let beforeHtml = "";
  let afterHtml = "";

  for (const part of parts) {
    const escaped = escapeHtml(part.value);
    if (part.added) {
      afterHtml += `<span class="diff-add">${escaped}</span>`;
      continue;
    }
    if (part.removed) {
      beforeHtml += `<span class="diff-del">${escaped}</span>`;
      continue;
    }
    beforeHtml += escaped;
    afterHtml += escaped;
  }

  return {
    beforeHtml,
    afterHtml
  };
}

function getElementSelector($, node) {
  const segments = [];
  let current = node;

  while (current && current.type === "tag") {
    const tag = current.tagName.toLowerCase();
    const id = current.attribs?.id;

    if (id) {
      segments.unshift(`${tag}#${id}`);
      break;
    }

    const position = $(current).parent().children(tag).index(current) + 1;
    segments.unshift(`${tag}:nth-of-type(${position})`);
    current = current.parent;
  }

  return segments.join(" > ");
}

function normalizeAttributes(attribs = {}) {
  return Object.entries(attribs)
    .filter(([key]) => !DYNAMIC_ATTRIBUTES.has(key) && !key.startsWith("data-"))
    .sort(([a], [b]) => a.localeCompare(b))
    .reduce((acc, [key, value]) => {
      acc[key] = (value ?? "").trim();
      return acc;
    }, {});
}

function buildNodeMap(html) {
  const $ = load(html);
  const nodes = new Map();

  $("*").each((_, node) => {
    if (!node.tagName) {
      return;
    }

    const selector = getElementSelector($, node);
    const text = $(node)
      .contents()
      .filter((__, child) => child.type === "text")
      .text()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);

    nodes.set(selector, {
      tag: node.tagName.toLowerCase(),
      text,
      attributes: normalizeAttributes(node.attribs),
      html: $.html(node)
    });
  });

  return nodes;
}

function getDomSeverity(totalChanges) {
  if (totalChanges === 0) return "None";
  if (totalChanges <= 5) return "Low";
  if (totalChanges <= 15) return "Medium";
  return "High";
}

export function compareDOM(oldHtml, newHtml) {
  const cleanedOld = cleanHtml(oldHtml);
  const cleanedNew = cleanHtml(newHtml);

  const oldMap = buildNodeMap(cleanedOld);
  const newMap = buildNodeMap(cleanedNew);

  const changes = [];

  for (const [selector, oldNode] of oldMap.entries()) {
    const newNode = newMap.get(selector);

    if (!newNode) {
      const oldHtml = trimSnippet(oldNode?.html ?? "");
      const { beforeHtml } = buildHighlightedDiff(oldHtml, "");
      changes.push({
        type: "removed",
        selector,
        oldHtml,
        newHtml: "",
        beforeHtml,
        afterHtml: ""
      });
      continue;
    }

    if (JSON.stringify(oldNode.attributes) !== JSON.stringify(newNode.attributes)) {
      const oldHtml = trimSnippet(oldNode?.html ?? "");
      const newHtml = trimSnippet(newNode?.html ?? "");
      const { beforeHtml, afterHtml } = buildHighlightedDiff(oldHtml, newHtml);
      changes.push({
        type: "attribute_changed",
        selector,
        oldAttributes: oldNode.attributes,
        newAttributes: newNode.attributes,
        oldHtml,
        newHtml,
        beforeHtml,
        afterHtml
      });
    }

    if (oldNode.text !== newNode.text) {
      const oldHtml = trimSnippet(oldNode?.html ?? "");
      const newHtml = trimSnippet(newNode?.html ?? "");
      const { beforeHtml, afterHtml } = buildHighlightedDiff(oldHtml, newHtml);
      changes.push({
        type: "text_changed",
        selector,
        oldText: oldNode.text,
        newText: newNode.text,
        oldHtml,
        newHtml,
        beforeHtml,
        afterHtml
      });
    }
  }

  for (const selector of newMap.keys()) {
    if (!oldMap.has(selector)) {
      const newNode = newMap.get(selector);
      const newHtml = trimSnippet(newNode?.html ?? "");
      const { afterHtml } = buildHighlightedDiff("", newHtml);
      changes.push({
        type: "added",
        selector,
        oldHtml: "",
        newHtml,
        beforeHtml: "",
        afterHtml
      });
    }
  }

  const summary = {
    added: changes.filter((c) => c.type === "added").length,
    removed: changes.filter((c) => c.type === "removed").length,
    attributeChanged: changes.filter((c) => c.type === "attribute_changed").length,
    textChanged: changes.filter((c) => c.type === "text_changed").length
  };

  summary.total = summary.added + summary.removed + summary.attributeChanged + summary.textChanged;

  return {
    summary: {
      ...summary,
      severity: getDomSeverity(summary.total)
    },
    changedSelectors: [...new Set(changes.map((change) => change.selector))],
    diffLog: changes.slice(0, 200),
    unifiedDiff: (() => {
      const patch = createTwoFilesPatch(
        "baseline.html",
        "current.html",
        cleanedOld,
        cleanedNew,
        "",
        "",
        { context: 3 }
      );

      if (patch.length <= MAX_UNIFIED_DIFF_CHARS) {
        return patch;
      }

      return `${patch.slice(0, MAX_UNIFIED_DIFF_CHARS)}\n...diff truncated (${patch.length} chars)`;
    })()
  };
}
