import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Worktree, FileChange } from '../types';

/** Error shape thrown by execFileSync (carries captured stdio and exit status). */
interface ExecError {
  stdout?: string;
  stderr?: string;
  status?: number | null;
  message?: string;
}

/**
 * Service for git operations including worktree management and change tracking.
 *
 * All git invocations go through {@link GitService.run}, which uses `execFileSync`
 * with an argument array (no shell). This is deliberate: branch names, paths, and
 * file names can contain shell metacharacters (and, for PRs, come from untrusted
 * third parties), so they must never be interpolated into a shell command string.
 */
export class GitService {
  /** Generous output limit so large repos' status/diff output isn't truncated. */
  private static readonly MAX_BUFFER = 64 * 1024 * 1024;

  /**
   * Run a git command with arguments passed as an array (never through a shell).
   * Throws on non-zero exit, like the previous execSync usage.
   */
  private run(args: string[], opts: { cwd?: string; input?: string; maxBuffer?: number } = {}): string {
    return execFileSync('git', args, {
      cwd: opts.cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.input,
      maxBuffer: opts.maxBuffer ?? GitService.MAX_BUFFER,
    }) as string;
  }

  /**
   * Check if a directory is a git repository
   */
  isGitRepository(dirPath: string): boolean {
    try {
      this.run(['rev-parse', '--git-dir'], { cwd: dirPath });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the root path of the git repository
   */
  getRepoRoot(dirPath: string): string | null {
    try {
      return this.run(['rev-parse', '--show-toplevel'], { cwd: dirPath }).trim();
    } catch {
      return null;
    }
  }

  /**
   * List all worktrees for a repository
   */
  listWorktrees(repoPath: string, repoId: string): Worktree[] {
    try {
      const output = this.run(['worktree', 'list', '--porcelain'], { cwd: repoPath });

      const worktrees: Worktree[] = [];
      const entries = output.trim().split('\n\n');

      for (const entry of entries) {
        if (!entry.trim()) continue;

        const lines = entry.split('\n');
        let worktreePath = '';
        let branch = '';
        let isMain = false;

        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            worktreePath = line.substring(9);
          } else if (line.startsWith('branch ')) {
            // refs/heads/main -> main
            branch = line.substring(7).replace('refs/heads/', '');
          } else if (line === 'bare') {
            // Skip bare repositories
            continue;
          }
        }

        // Determine if this is the main worktree (same as repo root)
        isMain = path.resolve(worktreePath) === path.resolve(repoPath);

        if (worktreePath) {
          worktrees.push({
            id: this.generateWorktreeId(repoId, worktreePath),
            repoId,
            name: branch || path.basename(worktreePath),
            path: worktreePath,
            isMain,
          });
        }
      }

      return worktrees;
    } catch (error) {
      console.error('Failed to list worktrees:', error);
      return [];
    }
  }

  /**
   * Generate a deterministic ID for a worktree based on repo and path
   */
  private generateWorktreeId(repoId: string, worktreePath: string): string {
    // Create a deterministic ID so we can reliably link chats to worktrees
    const normalized = path.resolve(worktreePath);
    const hash = this.simpleHash(`${repoId}:${normalized}`);
    return `wt-${hash}`;
  }

  /**
   * Simple hash function for generating deterministic IDs
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * Create a new worktree
   */
  createWorktree(repoPath: string, branch: string, worktreePath: string): boolean {
    try {
      this.run(['worktree', 'add', worktreePath, branch], { cwd: repoPath });
      return true;
    } catch (error) {
      console.error('Failed to create worktree:', error);
      return false;
    }
  }

  /**
   * Create a new worktree with a new branch
   */
  createWorktreeWithNewBranch(
    repoPath: string,
    newBranch: string,
    worktreePath: string,
    baseBranch: string = 'HEAD'
  ): boolean {
    try {
      this.run(['worktree', 'add', '-b', newBranch, worktreePath, baseBranch], { cwd: repoPath });
      return true;
    } catch (error) {
      console.error('Failed to create worktree with new branch:', error);
      return false;
    }
  }

  /**
   * Remove a worktree
   */
  removeWorktree(repoPath: string, worktreePath: string, force: boolean = false): boolean {
    try {
      const args = ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath];
      this.run(args, { cwd: repoPath });
      return true;
    } catch (error: unknown) {
      const execError = error as ExecError;
      const errorMessage = execError.stderr || execError.message || String(error);

      // Handle case where .git is a directory instead of a file (corrupted worktree)
      if (errorMessage.includes('is not a .git file') || errorMessage.includes('error code 3')) {
        console.log('Worktree has invalid .git structure, attempting manual cleanup...');
        return this.forceRemoveWorktree(repoPath, worktreePath);
      }

      console.error('Failed to remove worktree:', error);
      return false;
    }
  }

  /**
   * Force remove a worktree with invalid .git structure
   */
  private forceRemoveWorktree(repoPath: string, worktreePath: string): boolean {
    const resolvedPath = path.resolve(worktreePath);

    try {
      // Prune stale worktree references first
      try {
        this.run(['worktree', 'prune'], { cwd: repoPath });
      } catch {
        // Non-fatal, continue
      }

      // Remove the directory if it exists
      if (fs.existsSync(resolvedPath)) {
        fs.rmSync(resolvedPath, { recursive: true, force: true });
      }

      // Prune again to clean up any remaining references
      try {
        this.run(['worktree', 'prune'], { cwd: repoPath });
      } catch {
        // Non-fatal
      }

      return true;
    } catch (error) {
      console.error('Failed to force remove worktree:', error);
      return false;
    }
  }

  /**
   * Delete a branch
   */
  deleteBranch(repoPath: string, branchName: string, force: boolean = false): boolean {
    try {
      this.run(['branch', force ? '-D' : '-d', branchName], { cwd: repoPath });
      return true;
    } catch (error) {
      console.error('Failed to delete branch:', error);
      return false;
    }
  }

  /**
   * Check if a worktree has uncommitted changes
   */
  hasUncommittedChanges(worktreePath: string): boolean {
    try {
      const output = this.run(['status', '--porcelain'], { cwd: worktreePath });
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Copy uncommitted changes from one worktree to another.
   * Creates a patch from the source and applies it to the destination.
   * Also copies untracked files.
   */
  copyUncommittedChanges(sourceWorktree: string, destWorktree: string): boolean {
    try {
      // Get list of all changes (tracked and untracked)
      const statusOutput = this.run(['status', '--porcelain'], { cwd: sourceWorktree });

      if (!statusOutput.trim()) {
        return true; // No changes to copy
      }

      // Create a patch for tracked changes (both staged and unstaged)
      try {
        const patchOutput = this.run(['diff', 'HEAD'], {
          cwd: sourceWorktree,
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large diffs
        });

        if (patchOutput.trim()) {
          // Apply the patch to destination
          this.run(['apply', '--3way', '-'], {
            cwd: destWorktree,
            input: patchOutput,
          });
        }
      } catch (patchError) {
        console.error('Failed to apply patch:', patchError);
        // Continue to try copying untracked files
      }

      // Handle untracked files - copy them directly (fs, not shell tools)
      const lines = statusOutput.trim().split('\n');
      for (const line of lines) {
        if (line.startsWith('??')) {
          // Untracked file
          const filePath = line.substring(3).trim();
          const sourcePath = path.join(sourceWorktree, filePath);
          const destPath = path.join(destWorktree, filePath);

          try {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.cpSync(sourcePath, destPath, { recursive: true });
          } catch (copyError) {
            console.error(`Failed to copy untracked file ${filePath}:`, copyError);
          }
        }
      }

      return true;
    } catch (error) {
      console.error('Failed to copy uncommitted changes:', error);
      return false;
    }
  }

  /**
   * Merge a source branch into the target worktree
   * @param targetWorktreePath - Path to the worktree where merge will happen
   * @param sourceBranch - Branch name to merge from
   * @returns Object with success status and optional error message
   */
  mergeBranch(
    targetWorktreePath: string,
    sourceBranch: string
  ): { success: boolean; error?: string } {
    try {
      // Regular merge with --no-ff to preserve branch history
      this.run(['merge', '--no-ff', sourceBranch], { cwd: targetWorktreePath });
      return { success: true };
    } catch (error: unknown) {
      const execError = error as ExecError;
      const errorMessage = execError.stderr || execError.message || String(error);
      console.error('Failed to merge branch:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get the current HEAD commit SHA
   */
  getCurrentCommit(worktreePath: string): string | null {
    try {
      return this.run(['rev-parse', 'HEAD'], { cwd: worktreePath }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Get the current branch name
   */
  getCurrentBranch(worktreePath: string): string | null {
    try {
      return this.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Get list of available branches
   */
  getBranches(repoPath: string): string[] {
    try {
      const result = this.run(['branch', '-a', '--format=%(refname:short)'], { cwd: repoPath });
      return result
        .trim()
        .split('\n')
        .filter((b) => b && !b.includes('->'));
    } catch {
      return [];
    }
  }

  /**
   * List all remotes
   */
  listRemotes(repoPath: string): string[] {
    try {
      const output = this.run(['remote'], { cwd: repoPath });
      return output.trim().split('\n').filter(r => r);
    } catch {
      return [];
    }
  }

  /**
   * Check if a specific remote exists
   */
  hasRemote(repoPath: string, remoteName: string): boolean {
    return this.listRemotes(repoPath).includes(remoteName);
  }

  /**
   * Fetch from a specific remote
   */
  fetchRemote(repoPath: string, remoteName: string): boolean {
    try {
      this.run(['fetch', remoteName], { cwd: repoPath });
      return true;
    } catch (error) {
      console.error(`Failed to fetch from ${remoteName}:`, error);
      return false;
    }
  }

  /**
   * Fetch a specific branch from origin
   */
  fetchBranch(repoPath: string, branchName: string): boolean {
    try {
      this.run(['fetch', 'origin', branchName], { cwd: repoPath });
      return true;
    } catch (error) {
      console.error(`Failed to fetch branch ${branchName}:`, error);
      return false;
    }
  }

  /**
   * Fetch a pull request using gh CLI and create a local branch.
   * gh handles remote resolution automatically (origin, upstream, forks, etc.).
   */
  fetchPR(repoPath: string, prNumber: number, localBranchName: string): boolean {
    try {
      // gh pr checkout handles finding the correct remote and fetching.
      // Passed as an argument array (no shell) — prNumber is numeric and the
      // branch name is our own `pr-<n>`, but we still avoid shell interpolation.
      execFileSync('gh', ['pr', 'checkout', String(prNumber), '--branch', localBranchName], {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Switch back to the previous branch — the local branch remains for worktree use
      this.run(['checkout', '-'], { cwd: repoPath });
      return true;
    } catch (error) {
      console.error(`Failed to fetch PR #${prNumber}:`, error);
      return false;
    }
  }

  /**
   * Get branches for a specific remote
   */
  getRemoteBranches(repoPath: string, remoteName: string): string[] {
    try {
      const output = this.run(['branch', '-r', '--format=%(refname:short)'], { cwd: repoPath });
      return output
        .trim()
        .split('\n')
        .filter(b => b.startsWith(`${remoteName}/`) && !b.includes('->'));
    } catch {
      return [];
    }
  }

  /**
   * Get changed files since a base commit
   */
  getChangedFiles(worktreePath: string, baseCommit: string): FileChange[] {
    try {
      // Get diff stat
      const output = this.run(['diff', '--numstat', `${baseCommit}..HEAD`], { cwd: worktreePath });

      const changes: FileChange[] = [];

      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue;

        const [additions, deletions, filePath] = line.split('\t');

        // Handle binary files (shows as -)
        const adds = additions === '-' ? 0 : parseInt(additions, 10);
        const dels = deletions === '-' ? 0 : parseInt(deletions, 10);

        let status: FileChange['status'] = 'modified';
        if (adds > 0 && dels === 0) {
          status = 'added';
        } else if (adds === 0 && dels > 0) {
          status = 'deleted';
        }

        changes.push({
          path: filePath,
          status,
          additions: adds,
          deletions: dels,
        });
      }

      return changes;
    } catch (error) {
      console.error('Failed to get changed files:', error);
      return [];
    }
  }

  /**
   * Get unstaged and staged changes (working tree status)
   */
  getWorkingTreeChanges(worktreePath: string): FileChange[] {
    try {
      const output = this.run(['diff', '--numstat', 'HEAD'], { cwd: worktreePath });

      const changes: FileChange[] = [];

      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue;

        const [additions, deletions, filePath] = line.split('\t');
        const adds = additions === '-' ? 0 : parseInt(additions, 10);
        const dels = deletions === '-' ? 0 : parseInt(deletions, 10);

        let status: FileChange['status'] = 'modified';
        if (adds > 0 && dels === 0) {
          status = 'added';
        } else if (adds === 0 && dels > 0) {
          status = 'deleted';
        }

        changes.push({
          path: filePath,
          status,
          additions: adds,
          deletions: dels,
        });
      }

      return changes;
    } catch {
      return [];
    }
  }

  /**
   * Get the diff for a specific file
   */
  getFileDiff(worktreePath: string, filePath: string, baseCommit?: string): string {
    try {
      const range = baseCommit ? `${baseCommit}..HEAD` : 'HEAD';
      return this.run(['diff', range, '--', filePath], { cwd: worktreePath });
    } catch {
      return '';
    }
  }

  /**
   * Get staged changes (files added to index)
   */
  getStagedChanges(worktreePath: string): FileChange[] {
    try {
      const output = this.run(['diff', '--cached', '--numstat'], { cwd: worktreePath });
      return this.parseNumstatOutput(output, worktreePath, true);
    } catch {
      return [];
    }
  }

  /**
   * Get unstaged changes (modified but not added to index)
   */
  getUnstagedChanges(worktreePath: string): FileChange[] {
    try {
      // Get modified tracked files
      const trackedOutput = this.run(['diff', '--numstat'], { cwd: worktreePath });

      const changes = this.parseNumstatOutput(trackedOutput, worktreePath, false);

      // Get untracked files
      const untrackedOutput = this.run(['ls-files', '--others', '--exclude-standard'], { cwd: worktreePath });

      for (const line of untrackedOutput.trim().split('\n')) {
        if (!line.trim()) continue;
        changes.push({
          path: line.trim(),
          status: 'added',
          additions: 0,
          deletions: 0,
        });
      }

      return changes;
    } catch {
      return [];
    }
  }

  /**
   * Parse git diff --numstat output into FileChange array.
   * Status is resolved with filesystem/git lookups (no shell).
   */
  private parseNumstatOutput(output: string, worktreePath: string, staged: boolean): FileChange[] {
    const changes: FileChange[] = [];

    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;

      const [additions, deletions, filePath] = line.split('\t');
      const adds = additions === '-' ? 0 : parseInt(additions, 10);
      const dels = deletions === '-' ? 0 : parseInt(deletions, 10);

      let status: FileChange['status'] = 'modified';
      const existsInWorkingTree = fs.existsSync(path.join(worktreePath, filePath));

      if (!existsInWorkingTree) {
        status = 'deleted';
      } else if (staged) {
        // For staged changes, check against HEAD to detect new files
        try {
          this.run(['cat-file', '-e', `HEAD:${filePath}`], { cwd: worktreePath });
          status = 'modified';
        } catch {
          status = 'added';
        }
      } else {
        // For unstaged changes, check if tracked in index
        try {
          this.run(['ls-files', '--error-unmatch', filePath], { cwd: worktreePath });
          status = 'modified';
        } catch {
          status = 'added';
        }
      }

      changes.push({
        path: filePath,
        status,
        additions: adds,
        deletions: dels,
      });
    }

    return changes;
  }

  /**
   * Stage a file
   */
  stageFile(worktreePath: string, filePath: string): boolean {
    try {
      this.run(['add', '--', filePath], { cwd: worktreePath });
      return true;
    } catch (error) {
      console.error('Failed to stage file:', error);
      return false;
    }
  }

  /**
   * Unstage a file
   */
  unstageFile(worktreePath: string, filePath: string): boolean {
    try {
      this.run(['reset', 'HEAD', '--', filePath], { cwd: worktreePath });
      return true;
    } catch (error) {
      console.error('Failed to unstage file:', error);
      return false;
    }
  }

  /**
   * Discard unstaged changes to a file (restore working tree from index)
   */
  discardFile(worktreePath: string, filePath: string): boolean {
    try {
      // Check if file is untracked
      let tracked = true;
      try {
        this.run(['ls-files', '--error-unmatch', filePath], { cwd: worktreePath });
      } catch {
        tracked = false;
      }

      if (tracked) {
        // File is tracked - restore working tree from index (preserves staged changes)
        this.run(['checkout', '--', filePath], { cwd: worktreePath });
      } else {
        // File is untracked - just delete it
        const fullPath = path.join(worktreePath, filePath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }
      return true;
    } catch (error) {
      console.error('Failed to discard file:', error);
      return false;
    }
  }

  /**
   * Discard all unstaged and untracked changes
   */
  discardAll(worktreePath: string): boolean {
    try {
      // Restore working tree from index (preserves staged changes)
      this.run(['checkout', '--', '.'], { cwd: worktreePath });
      // Remove all untracked files and directories
      this.run(['clean', '-fd'], { cwd: worktreePath });
      return true;
    } catch (error) {
      console.error('Failed to discard all changes:', error);
      return false;
    }
  }

  /**
   * Stage all changes
   */
  stageAll(worktreePath: string): boolean {
    try {
      this.run(['add', '-A'], { cwd: worktreePath });
      return true;
    } catch (error) {
      console.error('Failed to stage all:', error);
      return false;
    }
  }

  /**
   * Unstage all changes
   */
  unstageAll(worktreePath: string): boolean {
    try {
      this.run(['reset', 'HEAD'], { cwd: worktreePath });
      return true;
    } catch (error) {
      console.error('Failed to unstage all:', error);
      return false;
    }
  }

  getRebaseRemote(worktreePath: string): { remote: string; branch: string } | null {
    try {
      const remotes = this.listRemotes(worktreePath);
      let remote: string | undefined;
      if (remotes.includes('upstream')) {
        remote = 'upstream';
      } else if (remotes.includes('origin')) {
        remote = 'origin';
      }
      if (!remote) {
        return null;
      }

      // Fetch to ensure remote tracking branches are available
      this.fetchRemote(worktreePath, remote);

      const remoteBranches = this.getRemoteBranches(worktreePath, remote);
      const branchNames = remoteBranches.map(b => b.replace(`${remote}/`, ''));
      let branch: string | undefined;
      if (branchNames.includes('main')) {
        branch = `${remote}/main`;
      } else if (branchNames.includes('master')) {
        branch = `${remote}/master`;
      }
      if (!branch) {
        return null;
      }

      return { remote, branch };
    } catch {
      return null;
    }
  }

  isRebaseInProgress(worktreePath: string): boolean {
    try {
      const gitDir = this.run(['rev-parse', '--git-dir'], { cwd: worktreePath }).trim();

      const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(worktreePath, gitDir);
      return fs.existsSync(path.join(resolvedGitDir, 'rebase-merge')) ||
        fs.existsSync(path.join(resolvedGitDir, 'rebase-apply'));
    } catch {
      return false;
    }
  }

  getRebaseProgress(worktreePath: string): { current: number; total: number } | null {
    try {
      const gitDir = this.run(['rev-parse', '--git-dir'], { cwd: worktreePath }).trim();

      const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(worktreePath, gitDir);
      let rebaseDir = path.join(resolvedGitDir, 'rebase-merge');
      if (!fs.existsSync(rebaseDir)) {
        rebaseDir = path.join(resolvedGitDir, 'rebase-apply');
      }
      if (!fs.existsSync(rebaseDir)) {
        return null;
      }

      const current = parseInt(fs.readFileSync(path.join(rebaseDir, 'msgnum'), 'utf-8').trim(), 10);
      const total = parseInt(fs.readFileSync(path.join(rebaseDir, 'end'), 'utf-8').trim(), 10);
      return { current, total };
    } catch {
      return null;
    }
  }

  checkRebaseConflicts(worktreePath: string, onto: string): { hasConflicts: boolean; conflictingFiles: string[] } {
    try {
      this.run(['merge-tree', '--write-tree', onto, 'HEAD'], { cwd: worktreePath });
      return { hasConflicts: false, conflictingFiles: [] };
    } catch (error: unknown) {
      const execError = error as ExecError;
      if (execError.status && execError.stdout) {
        const files: string[] = [];
        const lines = execError.stdout.split('\n');
        for (const line of lines) {
          const match = line.match(/^CONFLICT \([^)]+\): .* in (.+)$/);
          if (match) {
            files.push(match[1]);
          }
        }
        return { hasConflicts: true, conflictingFiles: files };
      }
      return { hasConflicts: false, conflictingFiles: [] };
    }
  }

  isUpToDate(worktreePath: string, ref: string): boolean {
    try {
      this.run(['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd: worktreePath });
      return true;
    } catch {
      return false;
    }
  }

  rebase(worktreePath: string, onto: string): { success: boolean; error?: string } {
    try {
      this.run(['rebase', '--autostash', onto], { cwd: worktreePath });
      return { success: true };
    } catch (error: unknown) {
      const execError = error as ExecError;
      const errorMessage = execError.stderr || execError.message || String(error);
      console.error('Rebase failed:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  rebaseContinue(worktreePath: string): { success: boolean; error?: string } {
    try {
      this.run(['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: worktreePath });
      return { success: true };
    } catch (error: unknown) {
      const execError = error as ExecError;
      const errorMessage = execError.stderr || execError.message || String(error);
      console.error('Rebase continue failed:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  rebaseAbort(worktreePath: string): boolean {
    try {
      this.run(['rebase', '--abort'], { cwd: worktreePath });
      return true;
    } catch (error) {
      console.error('Rebase abort failed:', error);
      return false;
    }
  }

  rebaseSkip(worktreePath: string): { success: boolean; error?: string } {
    try {
      this.run(['rebase', '--skip'], { cwd: worktreePath });
      return { success: true };
    } catch (error: unknown) {
      const execError = error as ExecError;
      const errorMessage = execError.stderr || execError.message || String(error);
      console.error('Rebase skip failed:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }
}
