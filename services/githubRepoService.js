import { supabase } from "../lib/supabase.js";

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

async function readRepoBaseline(owner, repo) {
  const { data, error } = await supabase
    .from("code_repo_baselines")
    .select("*")
    .eq("owner", owner)
    .eq("repo", repo)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function writeRepoBaseline(snapshot) {
  const { error } = await supabase
    .from("code_repo_baselines")
    .upsert(
      {
        owner: snapshot.owner,
        repo: snapshot.repo,
        repository_url: snapshot.repositoryUrl,
        branch: snapshot.branch,
        commit_sha: snapshot.commitSha,
        commit_url: snapshot.commitUrl,
        committed_at: snapshot.committedAt
      },
      { onConflict: "owner,repo" }
    );

  if (error) {
    throw new Error(error.message);
  }
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

export async function scanGitHubRepository({ githubUrl }) {
  const { owner, repo, normalizedUrl } = parseGitHubRepoUrl(githubUrl);
  const currentSnapshot = await getRepoSnapshot(owner, repo);
  const baseline = await readRepoBaseline(owner, repo);

  if (!baseline) {
    await writeRepoBaseline(currentSnapshot);

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

  if (baseline.commit_sha === currentSnapshot.commitSha) {
    return {
      baselineCreated: false,
      repositoryUrl: normalizedUrl,
      branch: currentSnapshot.branch,
      previousCommitSha: baseline.commit_sha,
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
    `/repos/${owner}/${repo}/compare/${baseline.commit_sha}...${currentSnapshot.commitSha}`
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

  await writeRepoBaseline(currentSnapshot);

  return {
    baselineCreated: false,
    repositoryUrl: normalizedUrl,
    branch: currentSnapshot.branch,
    previousCommitSha: baseline.commit_sha,
    currentCommitSha: currentSnapshot.commitSha,
    currentCommitUrl: currentSnapshot.commitUrl,
    summary: summarizeFiles(changedFiles),
    changedFiles: changedFiles.slice(0, 200)
  };
}
