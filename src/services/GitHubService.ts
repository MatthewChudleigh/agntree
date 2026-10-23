import { execFile } from 'child_process';
import { promisify } from 'util';
import { PRInfo } from '../types';
import { GH_PR_FIELDS, GhPullRequest, RepoPullRequests, indexPullRequests, toPRInfo } from '../utils/github';

const execFileAsync = promisify(execFile);

/**
 * Service for interacting with GitHub via the gh CLI
 */
export class GitHubService {
  /** How many open PRs to read per repository for the worktree badges, however old. */
  private static readonly OPEN_PR_LIMIT = 500;
  /** How many recent PRs in any state (for merged and closed badges). */
  private static readonly RECENT_PR_LIMIT = 200;

  /** PRs by repository path */
  private prCache = new Map<string, RepoPullRequests>();

  /** Fetches in progress, so a repository is only asked for once at a time */
  private inflight = new Map<string, Promise<RepoPullRequests>>();

  /** Bumped by clearCache, so a fetch that started before it doesn't refill the cache. */
  private generation = 0;

  /** Whether gh CLI is available (cached) */
  private ghAvailable: boolean | null = null;

  /** Promise for ongoing gh availability check */
  private ghCheckPromise: Promise<boolean> | null = null;

  /**
   * Check if gh CLI is available (async)
   */
  async isGhAvailable(): Promise<boolean> {
    if (this.ghAvailable !== null) return this.ghAvailable;

    // Prevent multiple concurrent checks
    if (this.ghCheckPromise) return this.ghCheckPromise;

    this.ghCheckPromise = (async () => {
      try {
        await execFileAsync('gh', ['--version'], { timeout: 5000 });
        this.ghAvailable = true;
      } catch {
        this.ghAvailable = false;
      }
      this.ghCheckPromise = null;
      return this.ghAvailable;
    })();

    return this.ghCheckPromise;
  }

  /** A repository's PRs if they have been fetched since the last clearCache, else undefined. */
  getCachedPullRequests(repoPath: string): RepoPullRequests | undefined {
    return this.prCache.get(repoPath);
  }

  /**
   * Fetch a repository's PRs with two `gh pr list` calls (rather than one per worktree):
   * every open PR, and the most recent ones in any state so merged and closed PRs show
   * too. Failures give an empty result, which is cached like any other until the next
   * clearCache.
   * @param ownOwners owners of the repository's remotes; see {@link indexPullRequests}
   */
  fetchPullRequests(repoPath: string, ownOwners: string[] = []): Promise<RepoPullRequests> {
    const running = this.inflight.get(repoPath);
    if (running) {
      return running;
    }
    const generation = this.generation;
    const list = async (state: string, limit: number): Promise<GhPullRequest[]> => {
      try {
        const { stdout } = await execFileAsync(
          'gh',
          ['pr', 'list', '--state', state, '--limit', String(limit), '--json', GH_PR_FIELDS],
          { cwd: repoPath, timeout: 20000, maxBuffer: 16 * 1024 * 1024 }
        );
        return JSON.parse(stdout) as GhPullRequest[];
      } catch {
        return []; // Not a GitHub repository, gh not signed in, offline, ...
      }
    };
    const fetch = (async () => {
      let result: RepoPullRequests = { byBranch: new Map(), byNumber: new Map() };
      if (await this.isGhAvailable()) {
        const [recent, open] = await Promise.all([
          list('all', GitHubService.RECENT_PR_LIMIT),
          list('open', GitHubService.OPEN_PR_LIMIT),
        ]);
        result = indexPullRequests([...recent, ...open], ownOwners);
      }
      if (generation === this.generation) {
        this.prCache.set(repoPath, result);
        this.inflight.delete(repoPath);
      }
      return result;
    })();
    this.inflight.set(repoPath, fetch);
    return fetch;
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.generation++;
    this.prCache.clear();
    this.inflight.clear();
  }

  /**
   * List open PRs for a repository
   */
  async listPRs(repoPath: string): Promise<PRInfo[]> {
    if (!(await this.isGhAvailable())) return [];

    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'list', '--json', GH_PR_FIELDS, '--limit', '30'],
        { cwd: repoPath, timeout: 15000 }
      );
      return (JSON.parse(stdout) as GhPullRequest[]).map(toPRInfo);
    } catch {
      return [];
    }
  }

  /**
   * Fetch details for a specific PR by number or URL
   */
  async fetchPRDetails(repoPath: string, prRef: string): Promise<PRInfo | null> {
    if (!(await this.isGhAvailable())) return null;

    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'view', prRef, '--json', GH_PR_FIELDS],
        { cwd: repoPath, timeout: 10000 }
      );
      return toPRInfo(JSON.parse(stdout) as GhPullRequest);
    } catch {
      return null;
    }
  }

  /**
   * Format PR info for display in tree item description
   * Returns: "#123", "#123 ○" (draft), "#123 ✓" (merged), "#123 ✗" (closed)
   */
  formatPRDescription(prInfo: PRInfo | null | undefined): string {
    if (!prInfo) return '';

    const symbol = prInfo.isDraft
      ? ' ○'
      : prInfo.state === 'merged'
        ? ' ✓'
        : prInfo.state === 'closed'
          ? ' ✗'
          : '';

    return `#${prInfo.number}${symbol}`;
  }
}
