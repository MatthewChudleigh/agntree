import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Worktree, FileChange, WorkingTreeStatus } from '../types';

/** Time limits for git commands, in milliseconds. 0 means no limit. */
export const GIT_TIMEOUTS = {
  /** Quick local commands: status, rev-parse, worktree list, add, ... */
  local: 30_000,
  /** Local commands that can legitimately run long: merge, rebase, apply */
  long: 10 * 60_000,
  /** Commands that talk to a remote */
  network: 5 * 60_000,
} as const;

export interface GitRunOptions {
  cwd?: string;
  /** Text for stdin. Stdin is closed either way, so git never waits on it. */
  input?: string;
  /** Kill git after this long. Defaults to GIT_TIMEOUTS.local; 0 disables the limit. */
  timeoutMs?: number;
  /** Cancels the command, e.g. from a cancellable progress notification. */
  signal?: AbortSignal;
  /** Extra environment variables for this command. */
  env?: Record<string, string>;
}

/** A git command that exited non-zero, timed out, was cancelled, or couldn't start. */
export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly timedOut: boolean,
    public readonly cancelled: boolean
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** The git subcommand in an argument list, skipping leading `-c key=value` options. */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') {
      i++;
    } else if (!args[i].startsWith('-')) {
      return args[i];
    }
  }
  return '';
}

/** The most useful explanation of a failure: git's own message, or what happened. */
export function describeGitError(error: unknown): string {
  if (error instanceof GitError) {
    const command = `git ${subcommand(error.args)}`.trim();
    if (error.cancelled) {
      return `${command} was cancelled.`;
    }
    if (error.timedOut) {
      return `${command} timed out.`;
    }
    return error.stderr.trim() || error.stdout.trim() || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export type GitResult = { ok: true } | { ok: false; error: string };

export type MergeResult = { ok: true } | { ok: false; conflicts: string[]; error: string };

export type DeleteBranchResult =
  | { deleted: true }
  /** Refused because the branch has commits that aren't in `mergeTarget`. */
  | { deleted: false; notMerged: true; unmergedCommits: number; mergeTarget: string }
  | { deleted: false; notMerged: false; error: string };

export interface RebaseConflictCheck {
  /** False when git can't pre-check conflicts (needs `merge-tree --write-tree`, git 2.38+). */
  checked: boolean;
  hasConflicts: boolean;
  conflictingFiles: string[];
}

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeListEntry {
  path: string;
  head: string | null;
  /** Local branch name, or null when detached */
  branch: string | null;
  detached: boolean;
  bare: boolean;
}

/** One entry of `git status --porcelain=v2 -z`. */
export interface StatusEntry {
  kind: 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';
  /** Index (staged) status letter, '.' when unchanged */
  index: string;
  /** Working tree (unstaged) status letter, '.' when unchanged */
  worktree: string;
  path: string;
  origPath?: string;
}

type LineCounts = Map<string, { additions: number; deletions: number }>;

/** Parse `git worktree list --porcelain`. The first entry is always the main worktree. */
export function parseWorktreeList(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, bare: false };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    }
  }

  return entries;
}

/**
 * Parse `git status --porcelain=v2 -z`. Paths are raw (no C-quoting) and renames
 * carry their original path, which the old `--numstat` parsing got wrong.
 */
export function parseStatusV2(output: string): StatusEntry[] {
  const tokens = output.split('\0');
  const entries: StatusEntry[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.startsWith('# ')) {
      continue;
    }
    const fields = token.split(' ');
    switch (token[0]) {
      case '1': // 1 XY sub mH mI mW hH hI path
        entries.push({ kind: 'changed', index: fields[1][0], worktree: fields[1][1], path: fields.slice(8).join(' ') });
        break;
      case '2': // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next token
        entries.push({
          kind: 'renamed',
          index: fields[1][0],
          worktree: fields[1][1],
          path: fields.slice(9).join(' '),
          origPath: tokens[++i],
        });
        break;
      case 'u': // u XY sub m1 m2 m3 mW h1 h2 h3 path
        entries.push({ kind: 'unmerged', index: fields[1][0], worktree: fields[1][1], path: fields.slice(10).join(' ') });
        break;
      case '?':
        entries.push({ kind: 'untracked', index: '?', worktree: '?', path: token.slice(2) });
        break;
      case '!':
        entries.push({ kind: 'ignored', index: '!', worktree: '!', path: token.slice(2) });
        break;
    }
  }

  return entries;
}

/** Parse `git diff --numstat -z` into line counts keyed by (new) path. Binary files count as 0. */
export function parseNumstatZ(output: string): LineCounts {
  const counts: LineCounts = new Map();
  const tokens = output.split('\0');

  for (let i = 0; i < tokens.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(tokens[i]);
    if (!match) {
      continue;
    }
    let filePath = match[3];
    if (filePath === '') {
      // Rename or copy: the old and new paths follow as separate tokens.
      i += 2;
      filePath = tokens[i];
    }
    counts.set(filePath, {
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
    });
  }

  return counts;
}

function stagedStatus(letter: string): FileChange['status'] {
  switch (letter) {
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'modified';
  }
}

function unstagedStatus(letter: string): FileChange['status'] {
  switch (letter) {
    case 'A': // intent-to-add
      return 'added';
    case 'D':
      return 'deleted';
    default:
      return 'modified';
  }
}

/** Combine parsed status and line counts into the Changes panel's staged/unstaged lists. */
export function buildWorkingTreeStatus(entries: StatusEntry[], stagedCounts: LineCounts, unstagedCounts: LineCounts): WorkingTreeStatus {
  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  const counts = (map: LineCounts, filePath: string) => map.get(filePath) ?? { additions: 0, deletions: 0 };

  for (const entry of entries) {
    switch (entry.kind) {
      case 'untracked':
        unstaged.push({ path: entry.path, status: 'untracked', additions: 0, deletions: 0 });
        break;
      case 'unmerged':
        unstaged.push({ path: entry.path, status: 'conflicted', ...counts(unstagedCounts, entry.path) });
        break;
      case 'changed':
      case 'renamed':
        if (entry.index !== '.') {
          staged.push({
            path: entry.path,
            ...(entry.origPath !== undefined ? { origPath: entry.origPath } : {}),
            status: stagedStatus(entry.index),
            ...counts(stagedCounts, entry.path),
          });
        }
        if (entry.worktree !== '.') {
          unstaged.push({ path: entry.path, status: unstagedStatus(entry.worktree), ...counts(unstagedCounts, entry.path) });
        }
        break;
    }
  }

  return { staged, unstaged };
}

/**
 * Git operations for worktrees, branches, and the Changes panel.
 *
 * Every command goes through {@link GitService.run}: `execFile` with an argument array
 * (never a shell, since branch names and paths can come from third-party PRs), run
 * asynchronously with a timeout so a slow or hung git can't freeze the extension host.
 * In a Remote-SSH window that host also runs the Git extension and language servers.
 */
export class GitService {
  /** Generous output limit so large repos' status/diff output isn't truncated. */
  private static readonly MAX_BUFFER = 64 * 1024 * 1024;

  private static readonly BASE_ENV: Record<string, string> = {
    // Fail instead of waiting forever for a username/password prompt nobody can see.
    GIT_TERMINAL_PROMPT: '0',
    // Background status refreshes must not take index.lock, or an agent's concurrent
    // `git commit` in the same worktree can fail with "index.lock exists".
    GIT_OPTIONAL_LOCKS: '0',
  };

  /** Run git and resolve with stdout. Rejects with a {@link GitError}. */
  protected run(args: string[], opts: GitRunOptions = {}): Promise<string> {
    const fullArgs = ['-c', 'core.quotePath=false', ...args];

    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        'git',
        fullArgs,
        {
          cwd: opts.cwd,
          encoding: 'utf8',
          maxBuffer: GitService.MAX_BUFFER,
          timeout: opts.timeoutMs ?? GIT_TIMEOUTS.local,
          signal: opts.signal,
          windowsHide: true,
          env: { ...process.env, ...GitService.BASE_ENV, ...opts.env },
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout);
            return;
          }
          const err = error as NodeJS.ErrnoException & { code?: string | number | null; killed?: boolean };
          const cancelled = opts.signal?.aborted === true || err.name === 'AbortError';
          const timedOut = !cancelled && err.killed === true && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          const message = err.code === 'ENOENT' ? 'git was not found. Install git or add it to PATH.' : err.message;
          reject(new GitError(
            message,
            args,
            typeof err.code === 'number' ? err.code : null,
            String(stdout ?? ''),
            String(stderr ?? ''),
            timedOut,
            cancelled
          ));
        }
      );
      // Ignore EPIPE if git exits before reading stdin.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(opts.input ?? '');
    });
  }

  /** Run git; resolve with stdout, or null if it failed. */
  private async tryRun(args: string[], opts?: GitRunOptions): Promise<string | null> {
    try {
      return await this.run(args, opts);
    } catch {
      return null;
    }
  }

  /** Run git for its side effect and report success or git's error message. */
  private async attempt(args: string[], opts?: GitRunOptions): Promise<GitResult> {
    try {
      await this.run(args, opts);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeGitError(error) };
    }
  }

  // ============ Repository ============

  async isGitRepository(dirPath: string): Promise<boolean> {
    return (await this.tryRun(['rev-parse', '--git-dir'], { cwd: dirPath })) !== null;
  }

  async getRepoRoot(dirPath: string): Promise<string | null> {
    const output = await this.tryRun(['rev-parse', '--show-toplevel'], { cwd: dirPath });
    return output ? output.trim() : null;
  }

  async clone(url: string, destination: string, signal?: AbortSignal): Promise<GitResult> {
    // `--` stops a URL that starts with "-" being read as an option.
    return this.attempt(['clone', '--', url, destination], { timeoutMs: 0, signal });
  }

  // ============ Worktrees ============

  async listWorktrees(repoPath: string, repoId: string): Promise<Worktree[]> {
    let output: string;
    try {
      output = await this.run(['worktree', 'list', '--porcelain'], { cwd: repoPath });
    } catch (error) {
      console.error('Failed to list worktrees:', describeGitError(error));
      return [];
    }

    const entries = parseWorktreeList(output);
    return entries
      .filter((entry) => !entry.bare)
      .map((entry) => ({
        id: this.generateWorktreeId(repoId, entry.path),
        repoId,
        name: entry.branch ?? path.basename(entry.path),
        branch: entry.branch,
        head: entry.head,
        path: entry.path,
        // git always lists the main worktree first
        isMain: entry === entries[0],
        isDetached: entry.branch === null,
      }));
  }

  /**
   * Deterministic ID for a worktree, so chats stay linked across refreshes.
   * Changing this orphans every saved chat.
   */
  private generateWorktreeId(repoId: string, worktreePath: string): string {
    const normalized = path.resolve(worktreePath);
    return `wt-${this.simpleHash(`${repoId}:${normalized}`)}`;
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  async createWorktree(repoPath: string, branch: string, worktreePath: string): Promise<GitResult> {
    return this.attempt(['worktree', 'add', '--', worktreePath, branch], { cwd: repoPath, timeoutMs: GIT_TIMEOUTS.long });
  }

  async createWorktreeWithNewBranch(
    repoPath: string,
    newBranch: string,
    worktreePath: string,
    baseBranch: string = 'HEAD'
  ): Promise<GitResult> {
    return this.attempt(['worktree', 'add', '-b', newBranch, '--', worktreePath, baseBranch], {
      cwd: repoPath,
      timeoutMs: GIT_TIMEOUTS.long,
    });
  }

  async removeWorktree(repoPath: string, worktreePath: string, force: boolean = false): Promise<GitResult> {
    const result = await this.attempt(['worktree', 'remove', ...(force ? ['--force'] : []), '--', worktreePath], {
      cwd: repoPath,
      timeoutMs: GIT_TIMEOUTS.long,
    });
    if (result.ok) {
      return result;
    }
    // A worktree whose .git is a directory instead of a file can't be removed by git.
    if (result.error.includes('is not a .git file') || result.error.includes('error code 3')) {
      console.log('Worktree has invalid .git structure, attempting manual cleanup...');
      return this.forceRemoveWorktree(repoPath, worktreePath);
    }
    return result;
  }

  private async forceRemoveWorktree(repoPath: string, worktreePath: string): Promise<GitResult> {
    try {
      await this.tryRun(['worktree', 'prune'], { cwd: repoPath });
      await fs.promises.rm(path.resolve(worktreePath), { recursive: true, force: true });
      await this.tryRun(['worktree', 'prune'], { cwd: repoPath });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeGitError(error) };
    }
  }

  // ============ Branches ============

  async getCurrentCommit(worktreePath: string): Promise<string | null> {
    const output = await this.tryRun(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: worktreePath });
    return output ? output.trim() : null;
  }

  async getCurrentBranch(worktreePath: string): Promise<string | null> {
    const output = await this.tryRun(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath });
    return output ? output.trim() : null;
  }

  /** Local branches, then remote-tracking branches as `remote/branch`. Skips `remote/HEAD`. */
  async getBranches(repoPath: string): Promise<string[]> {
    const output = await this.tryRun(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], { cwd: repoPath });
    if (!output) {
      return [];
    }
    const branches: string[] = [];
    for (const ref of output.split('\n')) {
      if (ref.startsWith('refs/heads/')) {
        branches.push(ref.slice('refs/heads/'.length));
      } else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
        branches.push(ref.slice('refs/remotes/'.length));
      }
    }
    return branches;
  }

  /** Remote-tracking branches of one remote, as `remote/branch`. */
  async getRemoteBranches(repoPath: string, remoteName: string): Promise<string[]> {
    const output = await this.tryRun(['for-each-ref', '--format=%(refname)', `refs/remotes/${remoteName}/`], { cwd: repoPath });
    if (!output) {
      return [];
    }
    return output
      .split('\n')
      .filter((ref) => ref.startsWith(`refs/remotes/${remoteName}/`) && !ref.endsWith('/HEAD'))
      .map((ref) => ref.slice('refs/remotes/'.length));
  }

  /** Whether `ancestor` is reachable from `descendant`. */
  async isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
    return (await this.tryRun(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoPath })) !== null;
  }

  async countCommits(repoPath: string, range: string): Promise<number> {
    const output = await this.tryRun(['rev-list', '--count', range], { cwd: repoPath });
    return output ? Number(output.trim()) || 0 : 0;
  }

  /** Short name of the branch's upstream (e.g. `origin/main`), if it has one. */
  async getUpstream(repoPath: string, branch: string): Promise<string | null> {
    const output = await this.tryRun(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], { cwd: repoPath });
    return output ? output.trim() : null;
  }

  /**
   * Delete a local branch. Without `force`, refuses (and says how many commits would be
   * lost) when the branch isn't merged into its upstream, or into `repoPath`'s HEAD when
   * it has no upstream: the same rule `git branch -d` uses, checked here so the caller
   * can ask before forcing.
   */
  async deleteBranch(repoPath: string, branch: string, options: { force?: boolean } = {}): Promise<DeleteBranchResult> {
    if ((await this.tryRun(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: repoPath })) === null) {
      return { deleted: false, notMerged: false, error: `Branch "${branch}" does not exist.` };
    }
    if (!options.force) {
      const upstream = await this.getUpstream(repoPath, branch);
      const reference = upstream ?? 'HEAD';
      if (!(await this.isAncestor(repoPath, `refs/heads/${branch}`, reference))) {
        const unmergedCommits = await this.countCommits(repoPath, `${reference}..refs/heads/${branch}`);
        const mergeTarget = upstream ?? (await this.getCurrentBranch(repoPath)) ?? 'HEAD';
        return { deleted: false, notMerged: true, unmergedCommits, mergeTarget };
      }
    }
    const result = await this.attempt(['branch', options.force ? '-D' : '-d', '--', branch], { cwd: repoPath });
    return result.ok ? { deleted: true } : { deleted: false, notMerged: false, error: result.error };
  }

  // ============ Remotes ============

  async listRemotes(repoPath: string): Promise<string[]> {
    const output = await this.tryRun(['remote'], { cwd: repoPath });
    return output ? output.split('\n').map((r) => r.trim()).filter(Boolean) : [];
  }

  /** Remotes with their fetch URLs. */
  async listRemoteUrls(repoPath: string): Promise<{ name: string; url: string }[]> {
    const output = await this.tryRun(['remote', '-v'], { cwd: repoPath });
    if (!output) {
      return [];
    }
    const remotes = new Map<string, string>();
    for (const line of output.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
      if (match && !remotes.has(match[1])) {
        remotes.set(match[1], match[2]);
      }
    }
    return [...remotes].map(([name, url]) => ({ name, url }));
  }

  async hasRemote(repoPath: string, remoteName: string): Promise<boolean> {
    return (await this.listRemotes(repoPath)).includes(remoteName);
  }

  async fetchRemote(repoPath: string, remoteName: string, signal?: AbortSignal): Promise<GitResult> {
    return this.attempt(['fetch', '--', remoteName], { cwd: repoPath, timeoutMs: GIT_TIMEOUTS.network, signal });
  }

  /**
   * Fetch a pull request's head into local branch `localBranch` without checking anything
   * out. `source` is a remote name or URL for the repository the PR was opened against;
   * GitHub publishes every PR there as `refs/pull/<n>/head`, including PRs from forks.
   * An existing `localBranch` is only fast-forwarded, never reset.
   */
  async fetchPullRequest(
    repoPath: string,
    prNumber: number,
    localBranch: string,
    source: string,
    signal?: AbortSignal
  ): Promise<GitResult> {
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      return { ok: false, error: `Invalid PR number: ${prNumber}` };
    }
    return this.attempt(['fetch', '--no-tags', '--', source, `refs/pull/${prNumber}/head:refs/heads/${localBranch}`], {
      cwd: repoPath,
      timeoutMs: GIT_TIMEOUTS.network,
      signal,
    });
  }

  // ============ Working tree status ============

  async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    const output = await this.tryRun(['status', '--porcelain'], { cwd: worktreePath });
    return !!output && output.trim().length > 0;
  }

  /**
   * Staged and unstaged changes. Three git calls in total, however many files changed
   * (the old code ran one extra git process per file).
   */
  async getStatus(worktreePath: string): Promise<WorkingTreeStatus> {
    try {
      const [status, unstagedCounts, stagedCounts] = await Promise.all([
        this.run(['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: worktreePath }),
        this.run(['diff', '--numstat', '-z'], { cwd: worktreePath }),
        this.run(['diff', '--cached', '--numstat', '-z'], { cwd: worktreePath }),
      ]);
      return buildWorkingTreeStatus(parseStatusV2(status), parseNumstatZ(stagedCounts), parseNumstatZ(unstagedCounts));
    } catch (error) {
      console.error('Failed to read git status:', describeGitError(error));
      return { staged: [], unstaged: [] };
    }
  }

  async stageFiles(worktreePath: string, filePaths: string[]): Promise<GitResult> {
    return this.attempt(['add', '--', ...filePaths], { cwd: worktreePath });
  }

  async unstageFiles(worktreePath: string, filePaths: string[]): Promise<GitResult> {
    if (!(await this.getCurrentCommit(worktreePath))) {
      // No commits yet, so there's no HEAD to reset to.
      return this.attempt(['rm', '--cached', '-q', '--', ...filePaths], { cwd: worktreePath });
    }
    return this.attempt(['reset', '-q', 'HEAD', '--', ...filePaths], { cwd: worktreePath });
  }

  /**
   * Discard an unstaged change. Tracked files are restored from the index (staged changes
   * are kept). Untracked files are deleted. Untracked folders are refused: with
   * `--untracked-files=all` the only folders git reports are nested repositories, such
   * as Claude Code worktrees under `.claude/worktrees/`.
   */
  async discardChange(worktreePath: string, change: FileChange): Promise<GitResult> {
    if (change.status !== 'untracked') {
      return this.attempt(['checkout', '--', change.path], { cwd: worktreePath });
    }

    const refuse: GitResult = {
      ok: false,
      error: `"${change.path}" is a folder (probably a nested repository or worktree), so it was not deleted.`,
    };
    if (change.path.endsWith('/')) {
      return refuse;
    }
    const fullPath = path.join(worktreePath, change.path);
    try {
      if ((await fs.promises.lstat(fullPath)).isDirectory()) {
        return refuse;
      }
      await fs.promises.unlink(fullPath);
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true };
      }
      return { ok: false, error: describeGitError(error) };
    }
  }

  /** Discard all unstaged changes (staged ones are kept) and delete untracked files. */
  async discardAll(worktreePath: string): Promise<GitResult> {
    const restored = await this.attempt(['checkout', '--', '.'], { cwd: worktreePath });
    if (!restored.ok) {
      return restored;
    }
    // Without -ff, git clean leaves nested repositories (e.g. .claude/worktrees/*) alone.
    return this.attempt(['clean', '-fd'], { cwd: worktreePath });
  }

  async stageAll(worktreePath: string): Promise<GitResult> {
    return this.attempt(['add', '-A'], { cwd: worktreePath });
  }

  async unstageAll(worktreePath: string): Promise<GitResult> {
    if (!(await this.getCurrentCommit(worktreePath))) {
      return this.attempt(['rm', '-r', '--cached', '-q', '.'], { cwd: worktreePath });
    }
    return this.attempt(['reset', '-q', 'HEAD'], { cwd: worktreePath });
  }

  /**
   * Copy uncommitted changes from one worktree to another: tracked changes as a patch,
   * untracked files directly. Nested repositories are not copied.
   */
  async copyUncommittedChanges(sourceWorktree: string, destWorktree: string): Promise<boolean> {
    let ok = true;
    try {
      const patch = await this.run(['diff', 'HEAD', '--binary'], { cwd: sourceWorktree, timeoutMs: GIT_TIMEOUTS.long });
      if (patch.trim()) {
        await this.run(['apply', '--3way', '-'], { cwd: destWorktree, input: patch, timeoutMs: GIT_TIMEOUTS.long });
      }
    } catch (error) {
      console.error('Failed to copy tracked changes:', describeGitError(error));
      ok = false;
    }

    const status = await this.tryRun(['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: sourceWorktree });
    for (const entry of parseStatusV2(status ?? '')) {
      if (entry.kind !== 'untracked' || entry.path.endsWith('/')) {
        continue;
      }
      try {
        const destPath = path.join(destWorktree, entry.path);
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await fs.promises.copyFile(path.join(sourceWorktree, entry.path), destPath);
      } catch (error) {
        console.error(`Failed to copy untracked file ${entry.path}:`, error);
        ok = false;
      }
    }
    return ok;
  }

  // ============ Merge ============

  /**
   * Merge `sourceBranch` into the worktree. On conflicts the worktree is left mid-merge,
   * as git leaves it, and the conflicted files are returned so the caller can say so.
   */
  async mergeBranch(targetWorktreePath: string, sourceBranch: string): Promise<MergeResult> {
    try {
      await this.run(['merge', '--no-ff', '--no-edit', sourceBranch], {
        cwd: targetWorktreePath,
        timeoutMs: GIT_TIMEOUTS.long,
        env: { GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' },
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, conflicts: await this.getConflictedFiles(targetWorktreePath), error: describeGitError(error) };
    }
  }

  async getConflictedFiles(worktreePath: string): Promise<string[]> {
    const output = await this.tryRun(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: worktreePath });
    return output ? output.split('\0').filter(Boolean) : [];
  }

  async abortMerge(worktreePath: string): Promise<GitResult> {
    return this.attempt(['merge', '--abort'], { cwd: worktreePath });
  }

  // ============ Rebase ============

  /** Suggested branch to rebase onto: upstream/main, upstream/master, origin/main, origin/master. */
  async getRecommendedRebaseTarget(worktreePath: string): Promise<{ remote: string; branch: string } | null> {
    const remotes = await this.listRemotes(worktreePath);
    const remote = remotes.includes('upstream') ? 'upstream' : remotes.includes('origin') ? 'origin' : undefined;
    if (!remote) {
      return null;
    }
    const branches = await this.getRemoteBranches(worktreePath, remote);
    const branch = [`${remote}/main`, `${remote}/master`].find((b) => branches.includes(b));
    return branch ? { remote, branch } : null;
  }

  private async getGitDir(worktreePath: string): Promise<string | null> {
    const output = await this.tryRun(['rev-parse', '--absolute-git-dir'], { cwd: worktreePath });
    return output ? output.trim() : null;
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async isRebaseInProgress(worktreePath: string): Promise<boolean> {
    const gitDir = await this.getGitDir(worktreePath);
    if (!gitDir) {
      return false;
    }
    return (await this.exists(path.join(gitDir, 'rebase-merge'))) || (await this.exists(path.join(gitDir, 'rebase-apply')));
  }

  async getRebaseProgress(worktreePath: string): Promise<{ current: number; total: number } | null> {
    const gitDir = await this.getGitDir(worktreePath);
    if (!gitDir) {
      return null;
    }
    // The merge backend counts in msgnum/end; the apply backend in next/last.
    const layouts = [
      { dir: 'rebase-merge', current: 'msgnum', total: 'end' },
      { dir: 'rebase-apply', current: 'next', total: 'last' },
    ];
    for (const layout of layouts) {
      const dir = path.join(gitDir, layout.dir);
      if (!(await this.exists(dir))) {
        continue;
      }
      try {
        const current = parseInt((await fs.promises.readFile(path.join(dir, layout.current), 'utf-8')).trim(), 10);
        const total = parseInt((await fs.promises.readFile(path.join(dir, layout.total), 'utf-8')).trim(), 10);
        return { current, total };
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Predict whether rebasing onto `onto` will conflict, without touching the worktree. */
  async checkRebaseConflicts(worktreePath: string, onto: string): Promise<RebaseConflictCheck> {
    try {
      await this.run(['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', onto, 'HEAD'], {
        cwd: worktreePath,
        timeoutMs: GIT_TIMEOUTS.long,
      });
      return { checked: true, hasConflicts: false, conflictingFiles: [] };
    } catch (error) {
      // Exit 1 means conflicts. Anything else (e.g. 129 on git < 2.38) means we can't tell.
      if (error instanceof GitError && error.exitCode === 1) {
        // Output: <tree>\0<file>\0<file>\0...
        const files = error.stdout.split('\0').slice(1).filter(Boolean);
        return { checked: true, hasConflicts: true, conflictingFiles: [...new Set(files)] };
      }
      return { checked: false, hasConflicts: false, conflictingFiles: [] };
    }
  }

  async isUpToDate(worktreePath: string, ref: string): Promise<boolean> {
    return this.isAncestor(worktreePath, ref, 'HEAD');
  }

  /** Environment for rebase steps: never open an editor (GIT_EDITOR beats core.editor). */
  private static readonly NO_EDITOR = { GIT_EDITOR: 'true' };

  async rebase(worktreePath: string, onto: string): Promise<GitResult> {
    return this.attempt(['rebase', '--autostash', onto], { cwd: worktreePath, timeoutMs: GIT_TIMEOUTS.long, env: GitService.NO_EDITOR });
  }

  async rebaseContinue(worktreePath: string): Promise<GitResult> {
    return this.attempt(['-c', 'core.editor=true', 'rebase', '--continue'], {
      cwd: worktreePath,
      timeoutMs: GIT_TIMEOUTS.long,
      env: GitService.NO_EDITOR,
    });
  }

  async rebaseAbort(worktreePath: string): Promise<GitResult> {
    return this.attempt(['rebase', '--abort'], { cwd: worktreePath, timeoutMs: GIT_TIMEOUTS.long });
  }

  async rebaseSkip(worktreePath: string): Promise<GitResult> {
    return this.attempt(['rebase', '--skip'], { cwd: worktreePath, timeoutMs: GIT_TIMEOUTS.long, env: GitService.NO_EDITOR });
  }
}
