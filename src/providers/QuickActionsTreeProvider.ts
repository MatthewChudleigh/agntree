import * as vscode from 'vscode';
import type { ChildProcess } from 'child_process';
import { killProcessTree, stopProcessTree } from '../utils/processes';

/**
 * Quick Action type from settings
 *
 * Two modes:
 * 1. Claude mode: Use `prompt` and `allowedTools` to run Claude headlessly
 * 2. Command mode: Use `command` to run any shell command directly
 */
export interface QuickAction {
  name: string;
  icon?: string;
  /** Claude prompt (used with allowedTools) */
  prompt?: string;
  /** Allowed tools for Claude (used with prompt) */
  allowedTools?: string;
  /** Raw shell command to execute (alternative to prompt/allowedTools) */
  command?: string;
}

/**
 * Tree item for a quick action
 */
export class QuickActionItem extends vscode.TreeItem {
  constructor(
    public readonly action: QuickAction,
    public readonly index: number,
    public readonly worktreePath: string,
    public readonly isRunning: boolean = false
  ) {
    super(action.name, vscode.TreeItemCollapsibleState.None);

    // Show different icon based on running state
    if (isRunning) {
      this.iconPath = new vscode.ThemeIcon('sync~spin');
      this.contextValue = 'quickActionRunning';
      this.tooltip = `Running: ${action.command || action.prompt || ''}`;
    } else {
      // Determine icon: user-specified > Claude mode (sparkle) > command mode (zap)
      let iconId = action.icon;
      if (!iconId) {
        iconId = action.prompt ? 'sparkle' : 'zap';
      }
      this.iconPath = new vscode.ThemeIcon(iconId);
      this.contextValue = 'quickAction';
      this.tooltip = action.command || action.prompt || '';
    }
    // No command on click - use the inline play/stop button instead
  }
}

/**
 * Provides tree data for the Quick Actions view
 */
export class QuickActionsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  /** How long a stopped action gets to exit before it is killed outright. */
  private static readonly KILL_AFTER_MS = 5000;
  /** How long after that to wait for its output to close before showing it as stopped anyway. */
  private static readonly GIVE_UP_AFTER_MS = 2000;

  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Currently active worktree path */
  private activeWorktreePath: string | undefined;

  /** Track running actions by index -> process */
  private runningProcesses: Map<number, ChildProcess> = new Map();

  /** Stop requests in progress (they force-kill actions that ignore SIGTERM) */
  private stopping: Map<number, { cancel(): void }> = new Map();

  constructor() {}

  /**
   * Set the active worktree path for running actions
   */
  setActiveWorktreePath(path: string | undefined): void {
    this.activeWorktreePath = path;
    this.refresh();
  }

  /**
   * Get the active worktree path
   */
  getActiveWorktreePath(): string | undefined {
    return this.activeWorktreePath;
  }

  /**
   * Check if an action is running
   */
  isActionRunning(index: number): boolean {
    return this.runningProcesses.has(index);
  }

  /**
   * Mark an action as running and store its process
   */
  setActionRunning(index: number, process: ChildProcess): void {
    this.runningProcesses.set(index, process);
    this.refresh();
  }

  /**
   * Mark an action as stopped (called once its output has closed). With `process`, only if
   * that process is still the one recorded, so a late event from an earlier run can't
   * clear a newer run of the same action.
   */
  setActionStopped(index: number, process?: ChildProcess): void {
    if (process && this.runningProcesses.get(index) !== process) {
      return;
    }
    this.runningProcesses.delete(index);
    this.stopping.get(index)?.cancel();
    this.stopping.delete(index);
    this.refresh();
  }

  /**
   * Stop a running action and everything it started. It stays "running" until its output
   * closes; if it ignores the request it is killed after a few seconds, and if its output
   * still doesn't close it is shown as stopped anyway.
   */
  stopAction(index: number): boolean {
    const childProcess = this.runningProcesses.get(index);
    if (!childProcess) {
      return false;
    }
    if (!this.stopping.has(index)) {
      this.stopping.set(index, stopProcessTree(childProcess, {
        killAfterMs: QuickActionsTreeProvider.KILL_AFTER_MS,
        giveUpAfterMs: QuickActionsTreeProvider.GIVE_UP_AFTER_MS,
        isDone: () => this.runningProcesses.get(index) !== childProcess,
        onGiveUp: () => this.setActionStopped(index, childProcess),
      }));
    }
    return true;
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Dispose of resources — stop all running processes
   */
  dispose(): void {
    for (const [, childProcess] of this.runningProcesses) {
      killProcessTree(childProcess, 'SIGTERM');
    }
    this.runningProcesses.clear();
    for (const stop of this.stopping.values()) {
      stop.cancel();
    }
    this.stopping.clear();
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    // Only show root level items
    if (element) {
      return [];
    }

    // Get quick actions from settings
    const config = vscode.workspace.getConfiguration('agntree');
    const quickActions = config.get<QuickAction[]>('quickActions', []);

    if (quickActions.length === 0) {
      // Return empty - the welcome view will show
      return [];
    }

    // Use active worktree path or current workspace folder
    const worktreePath = this.activeWorktreePath ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      '';

    return quickActions.map((action, index) =>
      new QuickActionItem(action, index, worktreePath, this.runningProcesses.has(index))
    );
  }
}
