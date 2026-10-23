import * as vscode from 'vscode';
import { ChangesTreeProvider } from '../providers/ChangesTreeProvider';
import { QuickAction, QuickActionsTreeProvider } from '../providers/QuickActionsTreeProvider';
import { ProcessSpec, spawnProcessTree } from '../utils/processes';

/**
 * Register quick action related commands
 * @param getPullRequestNumber - the PR a worktree was checked out from, if any
 */
export function registerQuickActionCommands(
  context: vscode.ExtensionContext,
  changesProvider: ChangesTreeProvider,
  quickActionsProvider: QuickActionsTreeProvider,
  getPullRequestNumber: (worktreePath: string) => Promise<number | undefined>
): void {
  // Create output channel for Quick Actions
  const quickActionsOutput = vscode.window.createOutputChannel('Agntree Quick Actions');
  context.subscriptions.push(quickActionsOutput);

  /**
   * `claude -p` shows no workspace trust prompt and runs the hooks and MCP servers in the
   * folder's own `.claude/settings.json` and `.mcp.json`. In a worktree checked out from a
   * PR those files come from the PR's author, so ask first.
   */
  async function confirmClaudeInPullRequest(action: QuickAction, worktreePath: string): Promise<boolean> {
    const prNumber = await getPullRequestNumber(worktreePath);
    if (prNumber === undefined) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      `Run "${action.name}" in the worktree for PR #${prNumber}?`,
      {
        modal: true,
        detail:
          'This quick action runs Claude Code headlessly (claude -p). In that mode Claude Code shows no trust prompt ' +
          "and runs the hooks and MCP servers defined in the PR's .claude/settings.json and .mcp.json, so code written " +
          "by the PR's author can run on this machine. Only continue if you trust this PR.",
      },
      'Run Anyway'
    );
    return choice === 'Run Anyway';
  }

  // Helper function to run a quick action
  async function executeQuickAction(action: QuickAction, index: number, worktreePath: string): Promise<void> {
    // Check if already running
    if (quickActionsProvider.isActionRunning(index)) {
      vscode.window.showWarningMessage(`"${action.name}" is already running. Stop it first to run again.`);
      return;
    }

    // Validate action has either command or prompt+allowedTools
    if (!action.command && (!action.prompt || !action.allowedTools)) {
      vscode.window.showErrorMessage(
        `Quick action "${action.name}" is misconfigured. Provide either "command" or both "prompt" and "allowedTools".`
      );
      return;
    }

    if (!action.command && !(await confirmClaudeInPullRequest(action, worktreePath))) {
      return;
    }
    if (quickActionsProvider.isActionRunning(index)) {
      return; // started again while the confirmation was open
    }

    // Log start to output channel
    const timestamp = new Date().toLocaleTimeString();
    quickActionsOutput.appendLine(`\n[${timestamp}] Running: ${action.name}`);
    quickActionsOutput.appendLine('─'.repeat(50));

    let spec: ProcessSpec;
    if (action.command) {
      // Command mode: run raw shell command (cross-platform)
      quickActionsOutput.appendLine(`$ ${action.command}\n`);
      spec = { command: action.command };
    } else {
      // Claude mode: run claude with prompt and allowedTools
      quickActionsOutput.appendLine(`$ claude -p "${action.prompt}" --allowedTools "${action.allowedTools}"\n`);
      spec = { file: 'claude', args: ['-p', action.prompt!, '--allowedTools', action.allowedTools!] };
    }

    const childProcess = spawnProcessTree(spec, worktreePath);
    quickActionsProvider.setActionRunning(index, childProcess);

    // Show output as it arrives (setEncoding keeps multi-byte characters split across chunks intact).
    for (const stream of [childProcess.stdout, childProcess.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (text: string) => quickActionsOutput.append(text));
    }

    let finished = false;
    const finish = (line: string) => {
      if (finished) {
        return false;
      }
      finished = true;
      quickActionsProvider.setActionStopped(index, childProcess);
      quickActionsOutput.appendLine(`\n${line}`);
      quickActionsOutput.appendLine('─'.repeat(50));
      return true;
    };
    const offerOutput = (selection: string | undefined) => {
      if (selection === 'Show Output') {
        quickActionsOutput.show();
      }
    };

    childProcess.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        if (finish(`✓ ${action.name} completed`)) {
          vscode.window.showInformationMessage(`${action.name} completed`, 'Show Output').then(offerOutput);
          changesProvider.refresh();
        }
      } else if (code === null) {
        if (finish(`⊘ ${action.name} was stopped${signal ? ` (${signal})` : ''}`)) {
          vscode.window.showInformationMessage(`${action.name} stopped`);
        }
      } else if (finish(`✗ ${action.name} failed (exit code: ${code})`)) {
        vscode.window.showErrorMessage(`${action.name} failed`, 'Show Output').then(offerOutput);
      }
    });

    childProcess.on('error', (err: Error) => {
      if (finish(`Error: ${err.message}`)) {
        vscode.window.showErrorMessage(`Failed to run command: ${err.message}`);
      }
    });
  }

  // Stop Quick Action
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.stopQuickAction',
      async (item: unknown) => {
        if (!item || typeof item !== 'object' || !('index' in item)) {
          vscode.window.showErrorMessage('Invalid quick action item.');
          return;
        }

        const actionItem = item as { index: number; action: QuickAction };
        const stopped = quickActionsProvider.stopAction(actionItem.index);

        if (!stopped) {
          vscode.window.showWarningMessage(`"${actionItem.action.name}" is not running.`);
        }
      }
    )
  );

  // Run Quick Action by index (called programmatically)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.runQuickActionByIndex',
      async (index: number, worktreePath: string) => {
        const config = vscode.workspace.getConfiguration('agntree');
        const quickActions = config.get<QuickAction[]>('quickActions', []);

        if (index < 0 || index >= quickActions.length) {
          vscode.window.showErrorMessage('Invalid action index.');
          return;
        }

        const action = quickActions[index];
        await executeQuickAction(action, index, worktreePath);
      }
    )
  );

  // Run Quick Action from tree item (inline play button)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.runQuickActionFromTree',
      async (item: unknown) => {
        if (!item || typeof item !== 'object' || !('action' in item) || !('worktreePath' in item) || !('index' in item)) {
          vscode.window.showErrorMessage('Invalid quick action item.');
          return;
        }

        const actionItem = item as { action: QuickAction; index: number; worktreePath: string };
        await executeQuickAction(actionItem.action, actionItem.index, actionItem.worktreePath);
      }
    )
  );

  // Run Quick Action (shows picker - kept for menu button)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.runQuickAction',
      async () => {
        const worktree = changesProvider.getActiveWorktree();
        if (!worktree) {
          vscode.window.showErrorMessage('No active worktree selected.');
          return;
        }

        const config = vscode.workspace.getConfiguration('agntree');
        const quickActions = config.get<QuickAction[]>('quickActions', []);

        if (quickActions.length === 0) {
          const addNow = await vscode.window.showInformationMessage(
            'No quick actions configured. Would you like to add one?',
            'Add Quick Action'
          );
          if (addNow === 'Add Quick Action') {
            vscode.commands.executeCommand('agntree.addQuickAction');
          }
          return;
        }

        // Show picker
        const actionItems = quickActions.map((action, index) => {
          const desc = action.command || action.prompt || '';
          return {
            label: `$(${action.icon || 'play'}) ${action.name}`,
            description: desc.substring(0, 60) + (desc.length > 60 ? '...' : ''),
            action,
            index,
          };
        });

        const selected = await vscode.window.showQuickPick(actionItems, {
          placeHolder: 'Select a quick action to run',
        });

        if (!selected) {
          return;
        }

        await executeQuickAction(selected.action, selected.index, worktree.path);
      }
    )
  );

  // Add Quick Action (opens settings)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.addQuickAction',
      async () => {
        // Open settings focused on quickActions
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'agntree.quickActions'
        );
      }
    )
  );
}
