import * as vscode from 'vscode';
import { StorageService } from './services/StorageService';
import { GitService } from './services/GitService';
import { TerminalManager } from './services/TerminalManager';
import { SessionWatcher } from './services/SessionWatcher';
import { LiveSessionService } from './services/LiveSessionService';
import { WorkspacesTreeProvider } from './providers/WorkspacesTreeProvider';
import { ChangesTreeProvider } from './providers/ChangesTreeProvider';
import { QuickActionsTreeProvider } from './providers/QuickActionsTreeProvider';
import { FilesTreeProvider } from './providers/FilesTreeProvider';
import { registerRepositoryCommands } from './commands/repository';
import { registerWorktreeCommands } from './commands/worktree';
import { registerChatCommands } from './commands/chat';
import { registerQuickActionCommands } from './commands/quickActions';
import { registerFileCommands } from './commands/files';
import { samePath } from './utils/paths';
import { pullRequestNumberForWorktree } from './utils/github';

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('Agntree extension is activating...');

  // Initialize services
  const storageService = new StorageService(context);
  const gitService = new GitService();
  const sessionWatcher = new SessionWatcher(storageService);
  const terminalManager = new TerminalManager(storageService, sessionWatcher);
  const liveSessions = new LiveSessionService();

  // Sync terminal manager with any existing state
  terminalManager.syncWithExistingTerminals();

  // Initialize tree providers
  const workspacesProvider = new WorkspacesTreeProvider(
    storageService,
    gitService,
    terminalManager
  );

  const changesProvider = new ChangesTreeProvider(gitService);

  const quickActionsProvider = new QuickActionsTreeProvider();
  const filesProvider = new FilesTreeProvider();

  // Helper function to refresh the tree
  const refreshTree = () => {
    workspacesProvider.refresh();
  };

  // Link chats whose session started before this window (re)loaded
  sessionWatcher.resumePending(async (chat) => (await workspacesProvider.getWorktreeById(chat.worktreeId))?.path);

  // Register tree views
  const workspacesTreeView = vscode.window.createTreeView('agntree.workspacesView', {
    treeDataProvider: workspacesProvider,
    showCollapseAll: true,
  });

  const changesTreeView = vscode.window.createTreeView('agntree.changesView', {
    treeDataProvider: changesProvider,
    showCollapseAll: false,
  });

  const filesTreeView = vscode.window.createTreeView('agntree.filesView', {
    treeDataProvider: filesProvider,
    showCollapseAll: true,
  });

  const quickActionsTreeView = vscode.window.createTreeView('agntree.quickActionsView', {
    treeDataProvider: quickActionsProvider,
    showCollapseAll: false,
  });

  context.subscriptions.push(workspacesTreeView);
  context.subscriptions.push(changesTreeView);
  context.subscriptions.push(filesTreeView);
  context.subscriptions.push(quickActionsTreeView);

  // Helper to update view titles with active worktree and repo name
  const updateViewTitles = (worktree: import('./types').Worktree | undefined) => {
    if (worktree) {
      const repo = storageService.getRepository(worktree.repoId);
      const repoName = repo?.name || '';
      const suffix = repoName ? `${worktree.name} ~ ${repoName}` : worktree.name;
      changesTreeView.title = `Changes (${suffix})`;
      filesTreeView.title = `All Files (${suffix})`;
      quickActionsTreeView.title = `Quick Actions (${suffix})`;
    } else {
      changesTreeView.title = 'Changes';
      filesTreeView.title = 'All Files';
      quickActionsTreeView.title = 'Quick Actions';
    }
  };

  // Register commands
  registerRepositoryCommands(context, storageService, gitService, refreshTree);
  registerWorktreeCommands(
    context,
    storageService,
    gitService,
    terminalManager,
    liveSessions,
    refreshTree,
    (worktreeId) => workspacesProvider.getPRUrl(worktreeId)
  );
  registerChatCommands(
    context,
    storageService,
    gitService,
    terminalManager,
    workspacesProvider,
    changesProvider,
    liveSessions,
    refreshTree
  );
  registerQuickActionCommands(context, changesProvider, quickActionsProvider, async (worktreePath) => {
    const worktree = await workspacesProvider.findWorktreeByPath(worktreePath);
    return worktree ? pullRequestNumberForWorktree(worktree.branch, storageService.getPRWorktree(worktree.id)) : undefined;
  });
  registerFileCommands(context, filesProvider, gitService);

  // Auto-switch workspace setting commands
  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.disableAutoSwitch', async () => {
      const config = vscode.workspace.getConfiguration('agntree');
      await config.update('autoSwitchWorkspaceFolder', false, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Auto-switch workspace folder disabled');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.enableAutoSwitch', async () => {
      const config = vscode.workspace.getConfiguration('agntree');
      await config.update('autoSwitchWorkspaceFolder', true, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Auto-switch workspace folder enabled');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.disableFocusOnStartup', async () => {
      const cfg = vscode.workspace.getConfiguration('agntree');
      await cfg.update('focusOnStartup', false, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Focus on startup disabled');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.enableFocusOnStartup', async () => {
      const cfg = vscode.workspace.getConfiguration('agntree');
      await cfg.update('focusOnStartup', true, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Focus on startup enabled');
    })
  );

  // Refresh tree when chat names are auto-updated
  context.subscriptions.push(
    sessionWatcher.onChatNameUpdated(() => {
      refreshTree();
    })
  );

  // Another window on this machine added, renamed or removed something
  context.subscriptions.push(storageService.onDidChangeExternally(() => workspacesProvider.refresh({ pullRequests: false })));

  // Refresh quick actions view when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agntree.quickActions')) {
        quickActionsProvider.refresh();
      }
    })
  );

  // On activation, expand only the worktree matching the current VS Code workspace folder.
  // Runs in the background so git never delays activation.
  const currentFolderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (currentFolderPath) {
    workspacesProvider.findWorktreeByPath(currentFolderPath).then((activeWorktree) => {
      if (!activeWorktree) {
        return;
      }
      changesProvider.setActiveWorktree(activeWorktree);
      filesProvider.setActiveWorktree(activeWorktree);
      quickActionsProvider.setActiveWorktreePath(activeWorktree.path);
      updateViewTitles(activeWorktree);
      storageService.setActiveWorktreeId(activeWorktree.id);

      const revealActive = () => {
        const item = workspacesProvider.getWorktreeTreeItem(activeWorktree);
        workspacesTreeView.reveal(item, { select: true, focus: false, expand: true });
      };

      if (workspacesTreeView.visible) {
        setTimeout(revealActive, 100);
      } else {
        const d = workspacesTreeView.onDidChangeVisibility((e) => {
          if (e.visible) { d.dispose(); setTimeout(revealActive, 100); }
        });
        context.subscriptions.push(d);
      }
    }, (error) => console.error('Failed to find the active worktree:', error));
  }

  // Listen for tree view selection changes to update changes view and switch workspace
  context.subscriptions.push(
    workspacesTreeView.onDidChangeSelection(async (event) => {
      if (event.selection.length > 0) {
        const selected = event.selection[0];
        let worktree: import('./types').Worktree | undefined;

        if (selected.itemType === 'worktree') {
          // Worktree selected - show its changes
          worktree = selected.data as import('./types').Worktree;
        } else if (selected.itemType === 'chat') {
          // Chat selected - show parent worktree's changes
          const chat = selected.data as import('./types').ChatSession;
          storageService.setActiveChatId(chat.id);
          worktree = await workspacesProvider.getWorktreeById(chat.worktreeId);
          // Ignore the result if the selection moved on while git was running.
          if (workspacesTreeView.selection[0] !== selected) {
            return;
          }
        }

        if (!worktree) {
          return;
        }

        // Update the Changes and Files panels with the selected worktree
        changesProvider.setActiveWorktree(worktree);
        filesProvider.setActiveWorktree(worktree);

        // Update the Quick Actions panel with the selected worktree path
        quickActionsProvider.setActiveWorktreePath(worktree.path);

        // Update view titles with worktree and repo name
        updateViewTitles(worktree);

        // Save active worktree ID to storage (persists across extension host restarts)
        storageService.setActiveWorktreeId(worktree.id);

        // Switch VS Code workspace folder if enabled in settings
        const config = vscode.workspace.getConfiguration('agntree');
        const autoSwitch = config.get<boolean>('autoSwitchWorkspaceFolder', false);

        if (autoSwitch) {
          const worktreePath = worktree.path;
          const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

          if (!currentFolder || !samePath(currentFolder, worktreePath)) {
            const folderCount = vscode.workspace.workspaceFolders?.length || 0;
            vscode.workspace.updateWorkspaceFolders(
              0,           // Start at index 0
              folderCount, // Remove all existing folders
              { uri: vscode.Uri.file(worktreePath) } // Add new folder
            );
            // Extension host will restart, but active worktree ID is saved in storage
            // and will be restored on next activation
          }
        }
      }
    })
  );

  // Listen for terminal focus changes to select corresponding chat in tree
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal(async (terminal) => {
      if (!terminal) return;

      // Parse the chat ID from the terminal name
      const shortId = TerminalManager.parseChatIdFromTerminalName(terminal.name);

      if (shortId) {
        // Find the chat by ID prefix
        const chats = storageService.getChats();
        const chat = chats.find((c) => c.id.startsWith(shortId));

        if (chat) {
          // Update active chat and worktree
          storageService.setActiveChatId(chat.id);
          storageService.setActiveWorktreeId(chat.worktreeId);

          const worktree = await workspacesProvider.getWorktreeById(chat.worktreeId);
          if (worktree) {
            changesProvider.setActiveWorktree(worktree);
            filesProvider.setActiveWorktree(worktree);
            quickActionsProvider.setActiveWorktreePath(worktree.path);
            updateViewTitles(worktree);
          }

          // Reveal and select the chat in tree view
          const chatItem = workspacesProvider.getChatTreeItem(chat);
          workspacesTreeView.reveal(chatItem, { select: true, focus: false, expand: true });
        }
      }
    })
  );

  // Dispose resources on deactivation
  context.subscriptions.push({
    dispose: () => {
      terminalManager.dispose();
      changesProvider.dispose();
      filesProvider.dispose();
      workspacesProvider.dispose();
      quickActionsProvider.dispose();
      sessionWatcher.dispose();
      storageService.dispose();
    },
  });

  const config = vscode.workspace.getConfiguration('agntree');
  if (config.get<boolean>('focusOnStartup', false)) {
    vscode.commands.executeCommand('workbench.view.extension.agntree');
  }

  console.log('Agntree extension activated successfully!');
}

/**
 * Extension deactivation
 */
export function deactivate() {
  console.log('Agntree extension deactivated');
}
