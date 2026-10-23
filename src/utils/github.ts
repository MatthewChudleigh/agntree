/**
 * Helpers for locating the repository a pull request lives in, so a PR can be
 * fetched from `refs/pull/<n>/head` without checking anything out, and for reading
 * PRs from `gh pr list --json`.
 */
import { PRInfo } from '../types';

/** A pull request as `gh pr list --json` / `gh pr view --json` prints it. */
export interface GhPullRequest {
  number: number;
  title?: string;
  /** OPEN, MERGED or CLOSED */
  state?: string;
  isDraft?: boolean;
  url?: string;
  headRefName?: string;
  /** True when the PR's branch is in a fork rather than in the repository itself */
  isCrossRepository?: boolean;
  /** Owner of the repository the PR's branch is in (an object with `login`) */
  headRepositoryOwner?: { login?: string } | string | null;
}

/** Fields to request from `gh pr list/view --json`. */
export const GH_PR_FIELDS = 'number,title,state,isDraft,url,headRefName,isCrossRepository,headRepositoryOwner';

function headOwner(pr: GhPullRequest): string | undefined {
  const owner = typeof pr.headRepositoryOwner === 'string' ? pr.headRepositoryOwner : pr.headRepositoryOwner?.login;
  return owner?.toLowerCase();
}

/** Owners (lower-case) of a repository's remotes, e.g. `you` for a fork at github.com/you/app. */
export function remoteOwners(remotes: { url: string }[]): string[] {
  return remotes
    .map((remote) => normalizeRemoteUrl(remote.url)?.split('/')[1])
    .filter((owner): owner is string => !!owner);
}

export function toPRInfo(pr: GhPullRequest): PRInfo {
  const state = (pr.state ?? '').toLowerCase();
  return {
    number: pr.number,
    title: pr.title ?? '',
    state: state === 'open' || state === 'merged' ? state : 'closed',
    isDraft: pr.isDraft ?? false,
    url: pr.url ?? '',
    headRefName: pr.headRefName ?? '',
  };
}

export interface RepoPullRequests {
  /** The PR for each local branch name, from branches in this repository (not forks) */
  byBranch: Map<string, PRInfo>;
  byNumber: Map<number, PRInfo>;
}

/**
 * Index a repository's PRs (any state, newest first as gh lists them). A branch gets its
 * open PR if it has one, otherwise its newest merged or closed one. PRs from forks only
 * match branches when the fork belongs to `ownOwners` (the owners of this repository's
 * remotes, so your own fork's PRs show when gh reports them against upstream). Anyone
 * else's `main` or `patch-1` is not the local branch of that name.
 */
export function indexPullRequests(prs: GhPullRequest[], ownOwners: string[] = []): RepoPullRequests {
  const owners = new Set(ownOwners.map((owner) => owner.toLowerCase()));
  const byBranch = new Map<string, PRInfo>();
  const byNumber = new Map<number, PRInfo>();
  for (const pr of prs) {
    const info = toPRInfo(pr);
    byNumber.set(info.number, info);
    const fromOwnRepo = !pr.isCrossRepository || owners.has(headOwner(pr) ?? '');
    if (!fromOwnRepo || !info.headRefName) {
      continue;
    }
    const existing = byBranch.get(info.headRefName);
    if (!existing || (existing.state !== 'open' && info.state === 'open')) {
      byBranch.set(info.headRefName, info);
    }
  }
  return { byBranch, byNumber };
}

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

/**
 * The PR a worktree was checked out from: the number Checkout PR recorded for it, or the
 * `pr-<number>` branch name Checkout PR gives its branches. Such a worktree holds code
 * written by the PR's author, who may not be trusted (for example a PR from a fork).
 */
export function pullRequestNumberForWorktree(branch: string | null, recordedNumber: number | undefined): number | undefined {
  if (recordedNumber !== undefined) {
    return recordedNumber;
  }
  const match = branch ? /^pr-(\d+)$/.exec(branch) : null;
  return match ? Number(match[1]) : undefined;
}
