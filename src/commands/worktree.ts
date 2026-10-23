import * as vscode from 'vscode';
import * as path from 'path';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { GitHubService } from '../services/GitHubService';
import { WorkspaceTreeItem } from '../providers/WorkspacesTreeProvider';
import { Repository, Worktree } from '../types';
import { samePath } from '../utils/paths';
import { findRemoteForPullRequest, parsePullRequestUrl, pullRequestRepoUrl } from '../utils/github';
import { withCancellableProgress, withProgress } from '../utils/progress';

/**
 * Delete a branch, asking before force-deleting one with unmerged commits.
 * Called after the branch's worktree has been removed.
 */
async function deleteBranchSafely(gitService: GitService, repoPath: string, branch: string): Promise<void> {
  let result = await gitService.deleteBranch(repoPath, branch);

  if (!result.deleted && result.notMerged) {
    const commits = result.unmergedCommits === 1 ? '1 commit' : `${result.unmergedCommits} commits`;
    const choice = await vscode.window.showWarningMessage(
      `The worktree was deleted. Branch "${branch}" has ${commits} that ${result.unmergedCommits === 1 ? 'is' : 'are'} not merged into ${result.mergeTarget}.\n\n` +
        'Delete the branch anyway? Its unmerged commits will only be recoverable from the reflog.',
      { modal: true },
      'Delete Branch'
    );
    if (choice !== 'Delete Branch') {
      vscode.window.showInformationMessage(`Deleted the worktree. Kept branch "${branch}" because it has unmerged commits.`);
      return;
    }
    result = await gitService.deleteBranch(repoPath, branch, { force: true });
  }

  if (result.deleted) {
    vscode.window.showInformationMessage(`Deleted worktree and branch "${branch}"`);
  } else {
    const reason = 'error' in result ? result.error : 'unknown error';
    vscode.window.showWarningMessage(`The worktree was deleted, but branch "${branch}" was not: ${reason}`);
  }
}

/**
 * Register worktree-related commands
 */
export function registerWorktreeCommands(
  context: vscode.ExtensionContext,
  storageService: StorageService,
  gitService: GitService,
  refreshTree: () => void,
  getPRUrl: (worktreeId: string) => string | undefined
): void {
  // Add Worktree
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.addWorktree',
      async (item?: WorkspaceTreeItem) => {
        let repo: Repository | undefined;

        if (item && item.itemType === 'repository') {
          repo = item.data as Repository;
        } else {
          // Show quick pick to select repository
          const repos = storageService.getRepositories();
          if (repos.length === 0) {
            vscode.window.showErrorMessage('No repositories added. Add a repository first.');
            return;
          }

          const selected = await vscode.window.showQuickPick(
            repos.map((r) => ({
              label: r.name,
              description: r.rootPath,
              repo: r,
            })),
            { placeHolder: 'Select repository for new worktree' }
          );

          if (!selected) {
            return;
          }

          repo = selected.repo;
        }
        const targetRepo = repo;

        // Get available branches, and those already checked out in worktrees
        const [allBranches, existingWorktrees, hasUpstream] = await Promise.all([
          gitService.getBranches(targetRepo.rootPath),
          gitService.listWorktrees(targetRepo.rootPath, targetRepo.id),
          gitService.hasRemote(targetRepo.rootPath, 'upstream'),
        ]);
        const checkedOutBranches = new Set(existingWorktrees.map((w) => w.branch).filter((b): b is string => !!b));

        // Filter out branches already in worktrees (for existing branch option)
        const availableBranches = allBranches.filter(b => !checkedOutBranches.has(b));

        // Build options dynamically
        const worktreeOptions: { label: string; description: string; value: string }[] = [
          {
            label: 'Existing branch',
            description: 'Create worktree from an existing branch',
            value: 'existing',
          },
          {
            label: 'New branch',
            description: 'Create a new branch with a worktree',
            value: 'new',
          },
        ];

        if (hasUpstream) {
          worktreeOptions.push({
            label: 'From upstream',
            description: 'Fetch from upstream and create new branch',
            value: 'upstream',
          });
        }

        // Ask user what type of worktree
        const worktreeType = await vscode.window.showQuickPick(
          worktreeOptions,
          { placeHolder: 'How would you like to create the worktree?' }
        );

        if (!worktreeType) {
          return;
        }

        let branchName: string;
        let isNewBranch = false;
        let baseBranch: string | undefined;

        const validateNewBranchName = (value: string) => {
          if (!value || value.trim().length === 0) {
            return 'Branch name is required';
          }
          if (allBranches.includes(value)) {
            return 'Branch already exists';
          }
          // Basic git branch name validation
          if (!/^[\w\-\/\.]+$/.test(value)) {
            return 'Invalid branch name. Use only letters, numbers, hyphens, slashes, and dots.';
          }
          return undefined;
        };

        if (worktreeType.value === 'existing') {
          // Check if there are available branches
          if (availableBranches.length === 0) {
            vscode.window.showInformationMessage('All branches are already checked out in worktrees. Create a new branch instead.');
            return;
          }

          // Select existing branch (only show branches not already in worktrees)
          const selectedBranch = await vscode.window.showQuickPick(
            availableBranches.map((b) => ({ label: b })),
            { placeHolder: 'Select branch for worktree (branches already in worktrees are hidden)' }
          );

          if (!selectedBranch) {
            return;
          }

          branchName = selectedBranch.label;
        } else if (worktreeType.value === 'new') {
          // Select base branch first (can base off any branch, including checked out ones)
          const selectedBaseBranch = await vscode.window.showQuickPick(
            allBranches.map((b) => ({ label: b })),
            { placeHolder: 'Select base branch to create new branch from' }
          );

          if (!selectedBaseBranch) {
            return;
          }

          baseBranch = selectedBaseBranch.label;

          // Create new branch
          const newBranchName = await vscode.window.showInputBox({
            prompt: `Enter new branch name (based on ${baseBranch})`,
            placeHolder: 'feature/my-feature',
            validateInput: validateNewBranchName,
          });

          if (!newBranchName) {
            return;
          }

          branchName = newBranchName;
          isNewBranch = true;
        } else if (worktreeType.value === 'upstream') {
          const fetched = await withCancellableProgress('Fetching from upstream...', (signal) =>
            gitService.fetchRemote(targetRepo.rootPath, 'upstream', signal)
          );
          if (!fetched.ok) {
            vscode.window.showWarningMessage(`Couldn't fetch from upstream: ${fetched.error}. Showing the branches fetched earlier.`);
          }

          // Get upstream branches
          const upstreamBranches = await gitService.getRemoteBranches(targetRepo.rootPath, 'upstream');

          if (upstreamBranches.length === 0) {
            vscode.window.showErrorMessage('No branches found on upstream remote.');
            return;
          }

          // Let user select base branch from upstream
          const selectedUpstreamBranch = await vscode.window.showQuickPick(
            upstreamBranches.map(b => ({ label: b })),
            { placeHolder: 'Select upstream branch to base new branch on' }
          );

          if (!selectedUpstreamBranch) {
            return;
          }

          baseBranch = selectedUpstreamBranch.label;

          // Ask for new branch name
          const newBranchName = await vscode.window.showInputBox({
            prompt: `Enter new branch name (based on ${baseBranch})`,
            placeHolder: 'feature/my-feature',
            validateInput: validateNewBranchName,
          });

          if (!newBranchName) {
            return;
          }

          branchName = newBranchName;
          isNewBranch = true;
        } else {
          return;
        }

        // Determine worktree path (using dedicated worktrees folder)
        const parentDir = path.dirname(targetRepo.rootPath);
        const worktreesDir = path.join(parentDir, `${targetRepo.name}-worktrees`);
        const worktreePath = path.join(worktreesDir, branchName.replace(/\//g, '-'));

        // Create the worktree
        const result = await withProgress(`Creating worktree ${branchName}...`, () =>
          isNewBranch
            ? gitService.createWorktreeWithNewBranch(targetRepo.rootPath, branchName, worktreePath, baseBranch)
            : gitService.createWorktree(targetRepo.rootPath, branchName, worktreePath)
        );

        if (result.ok) {
          vscode.window.showInformationMessage(`Created worktree: ${branchName}`);
          refreshTree();
        } else {
          vscode.window.showErrorMessage(`Failed to create worktree: ${result.error}`);
        }
      }
    )
  );

  // Open in New Window
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.openInNewWindow',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;
        const uri = vscode.Uri.file(worktree.path);

        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
      }
    )
  );

  // Copy Worktree Path
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.copyWorktreePath',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;
        await vscode.env.clipboard.writeText(worktree.path);
        vscode.window.showInformationMessage(`Copied path: ${worktree.path}`);
      }
    )
  );

  // Open Terminal at Worktree
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.openTerminalAtWorktree',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;
        const terminal = vscode.window.createTerminal({
          name: `Terminal: ${worktree.name}`,
          cwd: worktree.path,
        });
        terminal.show();
      }
    )
  );

  // Switch to Workspace (manual switch when auto-switch is disabled)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.switchToWorkspace',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;
        const worktreePath = worktree.path;
        const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (!currentFolder || !samePath(currentFolder, worktreePath)) {
          const folderCount = vscode.workspace.workspaceFolders?.length || 0;
          vscode.workspace.updateWorkspaceFolders(
            0,
            folderCount,
            { uri: vscode.Uri.file(worktreePath) }
          );
        }
      }
    )
  );

  // Delete Worktree (actually removes the git worktree)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.deleteWorktree',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;

        // Don't allow deleting the main worktree
        if (worktree.isMain) {
          vscode.window.showErrorMessage('Cannot delete the main worktree. Use git commands directly if you need to remove the repository.');
          return;
        }

        const repo = storageService.getRepository(worktree.repoId);
        if (!repo) {
          vscode.window.showErrorMessage('Could not find parent repository.');
          return;
        }

        const hasChanges = await gitService.hasUncommittedChanges(worktree.path);

        const message = [`Delete worktree "${worktree.name}"?`, '', `Folder: ${worktree.path}`];
        // Only a real branch can be deleted. A detached worktree's name is just its folder
        // name, and deleting a branch by that name could remove an unrelated branch.
        message.push(worktree.branch ? `Branch: ${worktree.branch}` : 'HEAD is detached, so there is no branch to delete.');
        if (hasChanges) {
          message.push('', '⚠️ WARNING: This worktree has uncommitted changes that will be lost!');
        }

        const deleteWorktreeOnly = hasChanges ? 'Delete Worktree Only (force)' : 'Delete Worktree Only';
        const deleteWithBranch = hasChanges ? 'Delete Worktree & Branch (force)' : 'Delete Worktree & Branch';
        const choices = worktree.branch ? [deleteWorktreeOnly, deleteWithBranch] : [deleteWorktreeOnly];

        const confirm = await vscode.window.showWarningMessage(message.join('\n'), { modal: true }, ...choices);
        if (!confirm) {
          return;
        }

        const removed = await withProgress(`Deleting worktree ${worktree.name}...`, () =>
          gitService.removeWorktree(repo.rootPath, worktree.path, hasChanges)
        );
        if (!removed.ok) {
          vscode.window.showErrorMessage(`Failed to delete worktree: ${removed.error}`);
          return;
        }

        // The PR association is keyed by path; don't let it attach to a future worktree there.
        storageService.removePRWorktree(worktree.id);

        if (confirm === deleteWithBranch && worktree.branch) {
          await deleteBranchSafely(gitService, repo.rootPath, worktree.branch);
        } else {
          vscode.window.showInformationMessage(`Deleted worktree "${worktree.name}"`);
        }
        refreshTree();
      }
    )
  );

  // Merge Branch Into This Worktree
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.mergeWorktree',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const targetWorktree = item.data as Worktree;

        // Get the repository to find all worktrees/branches
        const repo = storageService.getRepository(targetWorktree.repoId);
        if (!repo) {
          vscode.window.showErrorMessage('Could not find repository.');
          return;
        }

        // Other worktrees that have a branch checked out (detached ones have nothing to merge by name)
        const allWorktrees = await gitService.listWorktrees(repo.rootPath, repo.id);
        const sourceWorktrees = allWorktrees.filter(
          (w) => w.id !== targetWorktree.id && w.branch && w.branch !== targetWorktree.branch
        );

        if (sourceWorktrees.length === 0) {
          vscode.window.showInformationMessage('No other worktree branches available to merge from.');
          return;
        }

        // Show picker for source branch
        const sourceItems = sourceWorktrees.map(w => ({
          label: w.branch as string,
          description: w.isMain ? '(main worktree)' : undefined,
          detail: w.path,
          worktree: w,
        }));

        const selected = await vscode.window.showQuickPick(sourceItems, {
          placeHolder: `Select branch to merge into "${targetWorktree.name}"`,
        });

        if (!selected) {
          return;
        }

        const sourceBranch = selected.label;

        // Check for uncommitted changes in target worktree
        if (await gitService.hasUncommittedChanges(targetWorktree.path)) {
          const proceed = await vscode.window.showWarningMessage(
            `"${targetWorktree.name}" has uncommitted changes. Commit or stash them before merging.`,
            'Merge Anyway',
            'Cancel'
          );
          if (proceed !== 'Merge Anyway') {
            return;
          }
        }

        const result = await withProgress(`Merging ${sourceBranch} into ${targetWorktree.name}...`, () =>
          gitService.mergeBranch(targetWorktree.path, sourceBranch)
        );

        if (result.ok) {
          vscode.window.showInformationMessage(
            `Successfully merged "${sourceBranch}" into "${targetWorktree.name}"`
          );
          refreshTree();
          return;
        }

        if (result.conflicts.length === 0) {
          vscode.window.showErrorMessage(`Failed to merge: ${result.error}`);
          return;
        }

        // git leaves the worktree mid-merge: say so, and offer a way out.
        const shown = result.conflicts.slice(0, 5).join(', ');
        const more = result.conflicts.length > 5 ? ` and ${result.conflicts.length - 5} more` : '';
        vscode.commands.executeCommand('agntree.refreshChanges');
        const choice = await vscode.window.showWarningMessage(
          `Merging "${sourceBranch}" into "${targetWorktree.name}" stopped with conflicts in ${result.conflicts.length} file(s): ${shown}${more}. ` +
            'The worktree is now mid-merge: resolve the conflicts and commit, or abort the merge.',
          'Open Terminal',
          'Abort Merge'
        );
        if (choice === 'Open Terminal') {
          const terminal = vscode.window.createTerminal({
            name: `Git: ${targetWorktree.name}`,
            cwd: targetWorktree.path,
          });
          terminal.show();
          terminal.sendText('git status');
        } else if (choice === 'Abort Merge') {
          const aborted = await gitService.abortMerge(targetWorktree.path);
          if (aborted.ok) {
            vscode.window.showInformationMessage(`Aborted the merge. "${targetWorktree.name}" is back where it was.`);
          } else {
            vscode.window.showErrorMessage(`Failed to abort the merge: ${aborted.error}`);
          }
          vscode.commands.executeCommand('agntree.refreshChanges');
        }
      }
    )
  );

  // Rebase onto Upstream
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.rebaseWorktree',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;

        if (await gitService.isRebaseInProgress(worktree.path)) {
          const choice = await vscode.window.showQuickPick(
            [
              { label: '$(check) Continue', value: 'continue' as const },
              { label: '$(close) Abort', value: 'abort' as const },
              { label: '$(debug-step-over) Skip', value: 'skip' as const },
            ],
            { placeHolder: 'A rebase is already in progress' }
          );
          if (!choice) {
            return;
          }
          if (choice.value === 'continue') {
            vscode.commands.executeCommand('agntree.rebaseContinue');
          } else if (choice.value === 'abort') {
            vscode.commands.executeCommand('agntree.rebaseAbort');
          } else {
            vscode.commands.executeCommand('agntree.rebaseSkip');
          }
          return;
        }

        // Fetch all remotes and collect branches
        const remotes = await gitService.listRemotes(worktree.path);
        if (remotes.length === 0) {
          vscode.window.showErrorMessage('No remotes configured for this repository.');
          return;
        }

        const fetchError = await withCancellableProgress('Fetching remotes...', async (signal) => {
          for (const remote of remotes) {
            const fetched = await gitService.fetchRemote(worktree.path, remote, signal);
            if (!fetched.ok) {
              return fetched.error;
            }
          }
          return undefined;
        });

        if (fetchError) {
          vscode.window.showErrorMessage(`Failed to fetch from remotes: ${fetchError}`);
          return;
        }

        // Collect all remote branches
        const allBranches: string[] = [];
        for (const remote of remotes) {
          allBranches.push(...(await gitService.getRemoteBranches(worktree.path, remote)));
        }

        if (allBranches.length === 0) {
          vscode.window.showErrorMessage('No remote branches found.');
          return;
        }

        // Detect recommended branch (upstream/main > upstream/master > origin/main > origin/master)
        const recommended = await gitService.getRecommendedRebaseTarget(worktree.path);
        const currentBranch = worktree.branch ?? (await gitService.getCurrentBranch(worktree.path));

        // Build QuickPick items with recommended at top
        const branchItems = allBranches
          .filter(b => b !== `${currentBranch}`) // exclude current
          .map(b => ({
            label: b === recommended?.branch ? `$(star) ${b}` : b,
            description: b === recommended?.branch ? '(Recommended)' : undefined,
            branch: b,
          }));

        // Sort: recommended first, then alphabetically
        branchItems.sort((a, b) => {
          if (a.branch === recommended?.branch) return -1;
          if (b.branch === recommended?.branch) return 1;
          return a.branch.localeCompare(b.branch);
        });

        const selectedBranch = await vscode.window.showQuickPick(branchItems, {
          placeHolder: `Select branch to rebase "${worktree.name}" onto`,
        });

        if (!selectedBranch) {
          return;
        }

        const targetBranch = selectedBranch.branch;

        if (await gitService.isUpToDate(worktree.path, targetBranch)) {
          vscode.window.showInformationMessage(
            `"${worktree.name}" is already up to date with ${targetBranch}.`
          );
          return;
        }

        const [conflictCheck, status] = await Promise.all([
          gitService.checkRebaseConflicts(worktree.path, targetBranch),
          gitService.getStatus(worktree.path),
        ]);
        const changeCount = status.staged.length + status.unstaged.length;

        const details: string[] = [];
        if (!conflictCheck.checked) {
          details.push('Conflict check unavailable (needs git 2.38+)');
        } else if (conflictCheck.hasConflicts) {
          details.push(`${conflictCheck.conflictingFiles.length} conflicting file(s): ${conflictCheck.conflictingFiles.join(', ')}`);
        } else {
          details.push('No conflicts detected');
        }
        if (changeCount > 0) {
          details.push(`${changeCount} uncommitted change(s) will be auto-stashed`);
        }

        const proceed = await vscode.window.showQuickPick(
          [
            {
              label: '$(check) Proceed with Rebase',
              description: details.join(' · '),
              value: 'proceed' as const,
            },
            { label: '$(close) Cancel', value: 'cancel' as const },
          ],
          {
            placeHolder: conflictCheck.hasConflicts
              ? `Conflicts detected rebasing onto ${targetBranch}`
              : `Rebase "${worktree.name}" onto ${targetBranch}`,
          }
        );

        if (!proceed || proceed.value !== 'proceed') {
          return;
        }

        const result = await withProgress(`Rebasing ${worktree.name} onto ${targetBranch}...`, () =>
          gitService.rebase(worktree.path, targetBranch)
        );

        if (result.ok) {
          vscode.window.showInformationMessage(
            `Successfully rebased "${worktree.name}" onto ${targetBranch}`
          );
          refreshTree();
        } else if (await gitService.isRebaseInProgress(worktree.path)) {
          vscode.window.showWarningMessage(
            'Rebase paused due to conflicts. Resolve conflicts and use the rebase controls in the Changes panel.'
          );
        } else {
          vscode.window.showErrorMessage(`Rebase failed: ${result.error}`);
        }

        vscode.commands.executeCommand('agntree.refreshChanges');
      }
    )
  );

  // Open PR in Browser
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.openPRInBrowser',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;
        const prUrl = getPRUrl(worktree.id);
        if (!prUrl) {
          vscode.window.showInformationMessage('No PR found for this branch.');
          return;
        }

        await vscode.env.openExternal(vscode.Uri.parse(prUrl));
      }
    )
  );

  // Checkout PR into a worktree
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.checkoutPR',
      async (item?: WorkspaceTreeItem) => {
        let repo: Repository | undefined;

        if (item && item.itemType === 'repository') {
          repo = item.data as Repository;
        } else {
          const repos = storageService.getRepositories();
          if (repos.length === 0) {
            vscode.window.showErrorMessage('No repositories added. Add a repository first.');
            return;
          }

          const selected = await vscode.window.showQuickPick(
            repos.map((r) => ({
              label: r.name,
              description: r.rootPath,
              repo: r,
            })),
            { placeHolder: 'Select repository to checkout PR from' }
          );

          if (!selected) {
            return;
          }

          repo = selected.repo;
        }
        const targetRepo = repo;

        const githubService = new GitHubService();

        if (!(await githubService.isGhAvailable())) {
          vscode.window.showErrorMessage('GitHub CLI (gh) is not installed or not authenticated. Install it from https://cli.github.com');
          return;
        }

        // Fetch open PRs with progress
        const prs = await withProgress('Fetching open PRs...', () => githubService.listPRs(targetRepo.rootPath));

        // Build QuickPick items
        const manualEntry = {
          label: '$(edit) Enter PR number or URL manually...',
          description: '',
          detail: '',
          prNumber: -1,
          branchName: '',
          url: '',
        };

        const prItems = prs.map((pr) => ({
          label: `#${pr.number} ${pr.title}`,
          description: pr.headRefName || '',
          detail: pr.isDraft ? 'Draft' : '',
          prNumber: pr.number,
          branchName: pr.headRefName || '',
          url: pr.url,
        }));

        const items = [manualEntry, ...prItems];

        if (prItems.length === 0) {
          items[0].detail = 'No open PRs found — enter a PR number or URL';
        }

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a PR to checkout',
          matchOnDescription: true,
        });

        if (!selected) {
          return;
        }

        let prNumber: number;
        let branchName: string;
        let prUrl: string;

        if (selected.prNumber === -1) {
          // Manual entry
          const input = await vscode.window.showInputBox({
            prompt: 'Enter PR number or GitHub PR URL',
            placeHolder: '123 or https://github.com/owner/repo/pull/123',
            validateInput: (value) => {
              if (!value || value.trim().length === 0) {
                return 'PR number or URL is required';
              }
              return undefined;
            },
          });

          if (!input) {
            return;
          }

          const prDetails = await withProgress('Fetching PR details...', () =>
            githubService.fetchPRDetails(targetRepo.rootPath, input.trim())
          );

          if (!prDetails) {
            vscode.window.showErrorMessage(`Could not find PR: ${input}`);
            return;
          }

          if (!prDetails.headRefName) {
            vscode.window.showErrorMessage('Could not determine branch name for this PR.');
            return;
          }

          prNumber = prDetails.number;
          branchName = prDetails.headRefName;
          prUrl = prDetails.url;
        } else {
          prNumber = selected.prNumber;
          branchName = selected.branchName;
          prUrl = selected.url;
        }

        // Use pr-<number> as the local branch name to avoid collisions
        const localBranch = `pr-${prNumber}`;

        // Check if this PR already has a worktree
        const existingWorktrees = await gitService.listWorktrees(targetRepo.rootPath, targetRepo.id);
        if (existingWorktrees.some((w) => w.branch === localBranch)) {
          vscode.window.showInformationMessage(`PR #${prNumber} already has a worktree.`);
          return;
        }

        // Fetch refs/pull/<n>/head from the PR's repository. This never checks anything
        // out, so the main worktree (and anything running in it) is left alone.
        const location = parsePullRequestUrl(prUrl);
        if (!location) {
          vscode.window.showErrorMessage(`Could not tell which repository PR #${prNumber} belongs to (URL: ${prUrl || 'none'}).`);
          return;
        }
        const remotes = await gitService.listRemoteUrls(targetRepo.rootPath);
        let source = findRemoteForPullRequest(remotes, location);
        if (!source) {
          const repoUrl = pullRequestRepoUrl(location);
          const choice = await vscode.window.showWarningMessage(
            `PR #${prNumber} is in ${location.owner}/${location.repo}, which isn't a remote of this repository.\n\nFetch it from ${repoUrl} anyway?`,
            { modal: true },
            'Fetch'
          );
          if (choice !== 'Fetch') {
            return;
          }
          source = repoUrl;
        }
        const fetchSource = source;

        const parentDir = path.dirname(targetRepo.rootPath);
        const worktreesDir = path.join(parentDir, `${targetRepo.name}-worktrees`);
        const worktreePath = path.join(worktreesDir, branchName.replace(/\//g, '-'));

        const outcome = await withCancellableProgress(`Checking out PR #${prNumber}...`, async (signal) => {
          const fetched = await gitService.fetchPullRequest(targetRepo.rootPath, prNumber, localBranch, fetchSource, signal);
          if (!fetched.ok) {
            return fetched;
          }
          return gitService.createWorktree(targetRepo.rootPath, localBranch, worktreePath);
        });

        if (outcome.ok) {
          // Store PR association for the new worktree
          const worktrees = await gitService.listWorktrees(targetRepo.rootPath, targetRepo.id);
          const newWorktree = worktrees.find((w) => w.branch === localBranch);
          if (newWorktree) {
            storageService.setPRWorktree(newWorktree.id, prNumber);
          }

          vscode.window.showInformationMessage(`Checked out PR #${prNumber}: ${branchName}`);
          refreshTree();
        } else {
          vscode.window.showErrorMessage(`Failed to check out PR #${prNumber}: ${outcome.error}`);
        }
      }
    )
  );
}
