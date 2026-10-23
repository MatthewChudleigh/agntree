/**
 * Helpers for locating the repository a pull request lives in, so a PR can be
 * fetched from `refs/pull/<n>/head` without checking anything out.
 */

export interface PullRequestLocation {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/** Parse `https://<host>/<owner>/<repo>/pull/<n>[/files...]`. Returns null for anything else. */
export function parsePullRequestUrl(url: string): PullRequestLocation | null {
  const match = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url.trim());
  if (!match) {
    return null;
  }
  const [, host, owner, repo, num] = match;
  if (!NAME.test(owner) || !NAME.test(repo)) {
    return null;
  }
  return { host: host.toLowerCase(), owner, repo, number: Number(num) };
}

/**
 * Reduce a git remote URL to `host/owner/repo` (lower-case, no `.git`), so remotes
 * written as https, `git@host:owner/repo`, or `ssh://git@host/owner/repo` compare equal.
 */
export function normalizeRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  let host: string | undefined;
  let repoPath: string | undefined;

  const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  const urlLike = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/.exec(trimmed);
  if (urlLike) {
    [, host, repoPath] = urlLike;
  } else if (scpLike) {
    [, host, repoPath] = scpLike;
  }
  if (!host || !repoPath) {
    return null;
  }

  const parts = repoPath.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const [owner, repo] = parts.slice(-2);
  return `${host}/${owner}/${repo}`.toLowerCase();
}

/** Name of the remote that points at the PR's repository, if there is one. */
export function findRemoteForPullRequest(
  remotes: { name: string; url: string }[],
  pr: PullRequestLocation
): string | null {
  const wanted = `${pr.host}/${pr.owner}/${pr.repo}`.toLowerCase();
  const match = remotes.find((r) => normalizeRemoteUrl(r.url) === wanted);
  return match ? match.name : null;
}

/** HTTPS clone URL for the PR's repository, used when no remote matches. */
export function pullRequestRepoUrl(pr: PullRequestLocation): string {
  return `https://${pr.host}/${pr.owner}/${pr.repo}.git`;
}
