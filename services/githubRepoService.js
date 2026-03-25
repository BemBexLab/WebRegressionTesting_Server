import path from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { ensureDirSync } from "fs-extra";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "website-regression-monitor"
  };

  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  return headers;
}

async function githubRequest(endpoint) {
  const response = await fetch(`${GITHUB_API_BASE}${endpoint}`, {
    headers: githubHeaders()
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API request failed (${response.status}): ${body || endpoint}`);
  }

  return response.json();
}

export function parseGitHubRepoUrl(input) {
  const url = new URL(input);

  if (!["github.com", "www.github.com"].includes(url.hostname)) {
    throw new Error("GitHub URL must be on github.com.");
  }

  const [owner, repoSegment] = url.pathname.split("/").filter(Boolean);

  if (!owner || !repoSegment) {
    throw new Error("GitHub URL must point to a repository.");
  }

  return {
    owner,
    repo: repoSegment.replace(/\.git$/i, ""),
    normalizedUrl: `https://github.com/${owner}/${repoSegment.replace(/\.git$/i, "")}`
  };
}

function getRepoBaselinePath(storageRoot, owner, repo) {
  return path.join(storageRoot, "code-baselines", `${owner}__${repo}.json`);
}

function readRepoBaseline(storageRoot, owner, repo) {
  const baselinePath = getRepoBaselinePath(storageRoot, owner, repo);

  if (!existsSync(baselinePath)) {
    return null;
  }

  return JSON.parse(readFileSync(baselinePath, "utf8"));
}

function writeRepoBaseline(storageRoot, owner, repo, snapshot) {
  const baselineDir = path.join(storageRoot, "code-baselines");
  ensureDirSync(baselineDir);
  const baselinePath = getRepoBaselinePath(storageRoot, owner, repo);
  writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2), "utf8");
}

async function getRepoSnapshot(owner, repo) {
  const repoData = await githubRequest(`/repos/${owner}/${repo}`);
  const branchName = repoData.default_branch;
  const branchData = await githubRequest(`/repos/${owner}/${repo}/branches/${branchName}`);

  return {
    owner,
    repo,
    repositoryUrl: repoData.html_url,
    branch: branchName,
    commitSha: branchData.commit.sha,
    commitUrl: branchData.commit.html_url ?? `${repoData.html_url}/commit/${branchData.commit.sha}`,
    committedAt: branchData.commit.commit?.committer?.date ?? null
  };
}

function summarizeFiles(files = []) {
  return {
    totalChangedFiles: files.length,
    added: files.filter((file) => file.status === "added").length,
    removed: files.filter((file) => file.status === "removed").length,
    modified: files.filter((file) => file.status === "modified").length,
    renamed: files.filter((file) => file.status === "renamed").length
  };
}

export async function scanGitHubRepository({ githubUrl, storageRoot }) {
  const { owner, repo, normalizedUrl } = parseGitHubRepoUrl(githubUrl);
  const currentSnapshot = await getRepoSnapshot(owner, repo);
  const baseline = readRepoBaseline(storageRoot, owner, repo);

  if (!baseline) {
    writeRepoBaseline(storageRoot, owner, repo, currentSnapshot);

    return {
      baselineCreated: true,
      repositoryUrl: normalizedUrl,
      branch: currentSnapshot.branch,
      previousCommitSha: null,
      currentCommitSha: currentSnapshot.commitSha,
      currentCommitUrl: currentSnapshot.commitUrl,
      summary: {
        totalChangedFiles: 0,
        added: 0,
        removed: 0,
        modified: 0,
        renamed: 0
      },
      changedFiles: []
    };
  }

  if (baseline.commitSha === currentSnapshot.commitSha) {
    return {
      baselineCreated: false,
      repositoryUrl: normalizedUrl,
      branch: currentSnapshot.branch,
      previousCommitSha: baseline.commitSha,
      currentCommitSha: currentSnapshot.commitSha,
      currentCommitUrl: currentSnapshot.commitUrl,
      summary: {
        totalChangedFiles: 0,
        added: 0,
        removed: 0,
        modified: 0,
        renamed: 0
      },
      changedFiles: []
    };
  }

  const compareData = await githubRequest(
    `/repos/${owner}/${repo}/compare/${baseline.commitSha}...${currentSnapshot.commitSha}`
  );
  const changedFiles = (compareData.files ?? []).map((file) => ({
    path: file.filename,
    previousPath: file.previous_filename ?? null,
    status: file.status,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    changes: file.changes ?? 0,
    patch: file.patch ?? null,
    blobUrl: file.blob_url ?? null
  }));

  writeRepoBaseline(storageRoot, owner, repo, currentSnapshot);

  return {
    baselineCreated: false,
    repositoryUrl: normalizedUrl,
    branch: currentSnapshot.branch,
    previousCommitSha: baseline.commitSha,
    currentCommitSha: currentSnapshot.commitSha,
    currentCommitUrl: currentSnapshot.commitUrl,
    summary: summarizeFiles(changedFiles),
    changedFiles: changedFiles.slice(0, 200)
  };
}
