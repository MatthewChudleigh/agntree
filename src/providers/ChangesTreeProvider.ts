import * as vscode from 'vscode';
import * as path from 'path';
import { FileChange, Worktree } from '../types';
import { GitService } from '../services/GitService';

/**
 * Section header for staged/unstaged changes. Holds its own file list, so a refresh
 * that overlaps an earlier one can't mix up their results.
 */
export class ChangeSectionItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly sectionType: 'staged' | 'unstaged',
    public readonly worktreePath: string,
    public readonly changes: FileChange[]
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);

    const totalAdditions = changes.reduce((sum, c) => sum + c.additions, 0);
    const totalDeletions = changes.reduce((sum, c) => sum + c.deletions, 0);
    const additions = totalAdditions > 0 ? `+${totalAdditions}` : '';
    const deletions = totalDeletions > 0 ? `-${totalDeletions}` : '';
    const stats = [additions, deletions].filter(Boolean).join(' ');
    this.description = `${changes.length} file(s)${stats ? ` ${stats}` : ''}`;

    this.iconPath = new vscode.ThemeIcon(
      sectionType === 'staged' ? 'check' : 'edit'
    );

    // Context for section-level actions (stage all, unstage all)
    this.contextValue = sectionType === 'staged' ? 'stagedSection' : 'unstagedSection';
  }
}

/**
 * Section header for rebase in progress
 */
export class RebaseSectionItem extends vscode.TreeItem {
  constructor(
    public readonly worktreePath: string,
    current: number,
    total: number
  ) {
    super('Rebase In Progress', vscode.TreeItemCollapsibleState.None);
    this.description = `Step ${current} of ${total}`;
    this.iconPath = new vscode.ThemeIcon('git-merge');
    this.contextValue = 'rebaseSection';
  }
}

/**
 * Tree item for changed files
 */
export class ChangeTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly change: FileChange,
    public readonly worktreePath: string,
    public readonly baseCommit: string | null,
    public readonly isStaged: boolean
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    // Use resourceUri to get file icon from the current theme (like Explorer)
    const fullPath = path.join(worktreePath, change.path);
    this.resourceUri = vscode.Uri.file(fullPath);

    // Status letter and line counts in description (like Source Control)
    const statusLetter = ChangeTreeItem.statusLetter(change.status);
    const additions = change.additions > 0 ? `+${change.additions}` : '';
    const deletions = change.deletions > 0 ? `-${change.deletions}` : '';
    const lineCounts = [additions, deletions].filter(Boolean).join(' ');
    this.description = lineCounts ? `${statusLetter} ${lineCounts}` : statusLetter;

    // Set tooltip
    const shownPath = change.origPath ? `${change.origPath} → ${change.path}` : change.path;
    this.tooltip = `${shownPath}\n${change.status}\n${additions} ${deletions}`.trim();

    // Set context value for menus (different for staged, unstaged, and conflicted)
    this.contextValue = isStaged ? 'stagedFile' : change.status === 'conflicted' ? 'conflictedFile' : 'unstagedFile';

    // Make clickable to open diff
    this.command = {
      command: 'agntree.openDiff',
      title: 'Open Diff',
      arguments: [this],
    };
  }

  /** Letters match VS Code's Source Control view. */
  private static statusLetter(status: FileChange['status']): string {
    switch (status) {
      case 'added':
        return 'A';
      case 'modified':
        return 'M';
      case 'deleted':
        return 'D';
      case 'renamed':
        return 'R';
      case 'untracked':
        return 'U';
      case 'conflicted':
        return '!';
      default:
        return '?';
    }
  }
}

/**
 * Provides tree data for the Changes view
 */
export class ChangesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Currently displayed worktree */
  private activeWorktree: Worktree | undefined;

  /** File watcher for auto-refresh */
  private fileWatcher: vscode.FileSystemWatcher | undefined;

  /** Debounce timer for refresh */
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private gitService: GitService) {}

  /**
   * Set the active worktree to display changes for
   */
  setActiveWorktree(worktree: Worktree | undefined): void {
    this.activeWorktree = worktree;
    this.setupFileWatcher();
    this.refresh();
  }

  /**
   * Set the active chat to display changes for (uses chat's worktree)
   */
  setActiveChat(_chatId: string | undefined, worktree?: Worktree): void {
    this.setActiveWorktree(worktree);
  }

  /**
   * Get the current active worktree
   */
  getActiveWorktree(): Worktree | undefined {
    return this.activeWorktree;
  }

  /**
   * Setup file watcher for auto-refresh
   */
  private setupFileWatcher(): void {
    // Dispose existing watcher
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }

    if (!this.activeWorktree) {
      return;
    }

    // Watch all files in the worktree
    const pattern = new vscode.RelativePattern(
      this.activeWorktree.path,
      '**/*'
    );

    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    // Debounced refresh on any file change
    const debouncedRefresh = () => {
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = setTimeout(() => {
        this.refresh();
      }, 500); // 500ms debounce
    };

    this.fileWatcher.onDidChange(debouncedRefresh);
    this.fileWatcher.onDidCreate(debouncedRefresh);
    this.fileWatcher.onDidDelete(debouncedRefresh);
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    // No active worktree
    if (!this.activeWorktree) {
      return [this.createPlaceholderItem('Select a worktree or chat to view changes')];
    }

    // If element is a changes section, return its file children
    if (element instanceof ChangeSectionItem) {
      return this.createFileItems(element.changes, element.worktreePath, element.sectionType === 'staged');
    }

    if (element) {
      return [];
    }

    // Root level - show sections
    const worktree = this.activeWorktree;
    const [status, rebaseInProgress] = await Promise.all([
      this.gitService.getStatus(worktree.path),
      this.gitService.isRebaseInProgress(worktree.path),
    ]);

    // The selection changed while git was running; the refresh for the new worktree replaces this one.
    if (this.activeWorktree !== worktree) {
      return [];
    }

    const items: vscode.TreeItem[] = [];

    vscode.commands.executeCommand('setContext', 'agntree.rebaseInProgress', rebaseInProgress);
    if (rebaseInProgress) {
      const progress = await this.gitService.getRebaseProgress(worktree.path);
      items.push(new RebaseSectionItem(
        worktree.path,
        progress?.current ?? 1,
        progress?.total ?? 1
      ));
    }

    const hasChanges = status.staged.length > 0 || status.unstaged.length > 0;
    vscode.commands.executeCommand('setContext', 'agntree.hasChanges', hasChanges);

    // No changes message
    if (!hasChanges && !rebaseInProgress) {
      items.push(this.createPlaceholderItem('No changes detected'));
      return items;
    }

    if (status.staged.length > 0) {
      items.push(new ChangeSectionItem('Staged Changes', 'staged', worktree.path, status.staged));
    }

    if (status.unstaged.length > 0) {
      items.push(new ChangeSectionItem('Changes', 'unstaged', worktree.path, status.unstaged));
    }

    return items;
  }

  /**
   * Create tree items for file changes
   */
  private createFileItems(changes: FileChange[], worktreePath: string, isStaged: boolean): vscode.TreeItem[] {
    // Sort changes: conflicts first, then added, modified, renamed, deleted
    const statusOrder: Record<FileChange['status'], number> = {
      conflicted: -1,
      added: 0,
      untracked: 0,
      modified: 1,
      renamed: 2,
      deleted: 3,
    };
    const sorted = [...changes].sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

    return sorted.map(change => new ChangeTreeItem(
      path.basename(change.path.replace(/\/$/, '')),
      change,
      worktreePath,
      null,
      isStaged
    ));
  }

  /**
   * Create a placeholder item for empty/error states
   */
  private createPlaceholderItem(message: string): vscode.TreeItem {
    const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('info');
    return item;
  }
}
