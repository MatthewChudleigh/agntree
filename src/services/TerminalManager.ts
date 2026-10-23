import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { ChatSession, Worktree } from '../types';
import { StorageService } from './StorageService';
import { ClaudeSessionService } from './ClaudeSessionService';
import { SessionWatcher } from './SessionWatcher';
import { claudeCommand, isSessionId } from '../utils/claudeCommand';

/**
 * Manages VS Code terminal instances for Claude Code chat sessions
 */
export class TerminalManager {
  /** Map of chat ID to terminal instance */
  private terminals: Map<string, vscode.Terminal> = new Map();

  /** Map of terminal to chat ID (for reverse lookup on close) */
  private terminalToChatId: Map<vscode.Terminal, string> = new Map();

  /** Disposable for terminal close listener */
  private onCloseTerminalDisposable: vscode.Disposable;

  /** Terminal name prefix */
  private static readonly TERMINAL_PREFIX = 'Agntree: ';

  /**
   * Generate a unique terminal name that includes the chat ID
   * Format: "Agntree: {chatName} [{shortId}]"
   */
  private static getTerminalName(chat: ChatSession): string {
    const shortId = chat.id.substring(0, 6);
    return `${TerminalManager.TERMINAL_PREFIX}${chat.name} [${shortId}]`;
  }

  /**
   * Parse the chat ID from a terminal name
   * Returns the short ID if found, null otherwise
   */
  static parseChatIdFromTerminalName(terminalName: string): string | null {
    if (!terminalName.startsWith(TerminalManager.TERMINAL_PREFIX)) {
      return null;
    }
    // Match the [shortId] at the end of the name
    const match = terminalName.match(/\[([a-f0-9]{6})\]$/);
    return match ? match[1] : null;
  }

  /** Event emitter for terminal state changes */
  private _onTerminalStateChange = new vscode.EventEmitter<{
    chatId: string;
    state: 'opened' | 'closed';
  }>();
  public readonly onTerminalStateChange = this._onTerminalStateChange.event;

  constructor(private storageService: StorageService, private sessionWatcher: SessionWatcher) {
    // Listen for terminal close events
    this.onCloseTerminalDisposable = vscode.window.onDidCloseTerminal((terminal) => {
      const chatId = this.terminalToChatId.get(terminal);
      if (chatId) {
        this.handleTerminalClosed(chatId, terminal);
      }
    });
  }

  /**
   * Open a chat in a terminal (creates new or focuses existing). A chat that hasn't
   * started yet is started with its pre-assigned session ID (a fork with
   * `--fork-session`), so its log can be found by name. Returns undefined if nothing
   * was opened.
   */
  openChat(chat: ChatSession, worktree: Worktree): vscode.Terminal | undefined {
    const existing = this.findTerminal(chat);
    if (existing) {
      existing.show();
      return existing;
    }

    const command = this.commandFor(chat, worktree);
    if (!command) {
      return undefined;
    }

    // Create new terminal in the editor area (not the bottom panel)
    const terminal = vscode.window.createTerminal({
      name: TerminalManager.getTerminalName(chat),
      cwd: worktree.path,
      iconPath: new vscode.ThemeIcon('comment-discussion'),
      location: vscode.TerminalLocation.Editor,
    });

    // Store mappings
    this.terminals.set(chat.id, terminal);
    this.terminalToChatId.set(terminal, chat.id);

    terminal.sendText(command);
    terminal.show();

    // Update chat status
    this.storageService.updateChat(chat.id, {
      status: 'active',
      lastAccessedAt: Date.now(),
    });

    this._onTerminalStateChange.fire({ chatId: chat.id, state: 'opened' });

    return terminal;
  }

  /** This window's terminal for a chat, if it has one (re-registering one found by name). */
  private findTerminal(chat: ChatSession): vscode.Terminal | undefined {
    const known = this.terminals.get(chat.id);
    if (known) {
      if (vscode.window.terminals.includes(known)) {
        return known;
      }
      // Terminal was closed but we missed the event - clean up
      this.terminals.delete(chat.id);
      this.terminalToChatId.delete(known);
    }

    // Also check if there's an existing terminal by name that we can reuse
    // Use the unique terminal name that includes chat.id to avoid collisions
    const terminalName = TerminalManager.getTerminalName(chat);
    const byName = vscode.window.terminals.find((t) => t.name === terminalName);
    if (byName) {
      this.terminals.set(chat.id, byName);
      this.terminalToChatId.set(byName, chat.id);
    }
    return byName;
  }

  /** The `claude` command that starts or resumes a chat, or undefined (after telling the user why). */
  private commandFor(chat: ChatSession, worktree: Worktree): string | undefined {
    // Use the saved chat: another window, or the session watcher, may have linked it.
    let current = this.storageService.getChat(chat.id) ?? chat;
    if (!current.claudeSessionId) {
      current = this.sessionWatcher.linkIfStarted(current.id, worktree.path) ?? current;
    }

    if (current.claudeSessionId) {
      if (!isSessionId(current.claudeSessionId)) {
        vscode.window.showErrorMessage(`"${current.claudeSessionId}" is not a valid Claude Code session ID.`);
        return undefined;
      }
      if (!new ClaudeSessionService().isSessionResumable(current.claudeSessionId)) {
        vscode.window.showWarningMessage(
          'Session not found or has no conversation. This can happen if a forked session was closed without interaction.',
          'Delete Chat',
          'Cancel'
        ).then(choice => {
          if (choice === 'Delete Chat') {
            this.storageService.deleteChat(chat.id);
            vscode.commands.executeCommand('agntree.refreshWorkspaces');
          }
        });
        return undefined;
      }
      return claudeCommand({ resume: current.claudeSessionId }) ?? undefined;
    }

    // Not started yet. Chats saved by older versions have no ID chosen in advance.
    let sessionId = current.pendingSessionId;
    if (!isSessionId(sessionId)) {
      sessionId = randomUUID();
      this.storageService.updateChat(chat.id, { pendingSessionId: sessionId });
    }
    const forkFrom = current.forkFromSessionId;
    const command = forkFrom
      ? claudeCommand({ forkFrom, newSessionId: sessionId })
      : claudeCommand({ newSessionId: sessionId });
    if (!command) {
      vscode.window.showErrorMessage(`"${forkFrom}" is not a valid Claude Code session ID.`);
      return undefined;
    }
    this.sessionWatcher.watchForSession(chat.id, sessionId, worktree.path);
    return command;
  }

  /**
   * Close a chat's terminal
   */
  closeChat(chatId: string): void {
    const terminal = this.terminals.get(chatId);
    if (terminal) {
      terminal.dispose();
      // Cleanup will happen in handleTerminalClosed via the event
    }
  }

  /**
   * Check if a chat has an active terminal
   */
  isActive(chatId: string): boolean {
    const terminal = this.terminals.get(chatId);
    if (!terminal) {
      return false;
    }
    // Verify terminal is still alive
    const isStillAlive = vscode.window.terminals.includes(terminal);
    if (!isStillAlive) {
      // Clean up stale reference
      this.terminals.delete(chatId);
      this.terminalToChatId.delete(terminal);
      return false;
    }
    return true;
  }

  /**
   * Get the terminal for a chat
   */
  getTerminal(chatId: string): vscode.Terminal | undefined {
    return this.terminals.get(chatId);
  }

  /**
   * Focus a chat's terminal if it exists
   */
  focusChat(chatId: string): boolean {
    const terminal = this.terminals.get(chatId);
    if (terminal) {
      terminal.show();
      return true;
    }
    return false;
  }

  /**
   * Handle terminal closed event
   */
  private handleTerminalClosed(chatId: string, terminal: vscode.Terminal): void {
    this.terminals.delete(chatId);
    this.terminalToChatId.delete(terminal);

    // Get the chat to check if it has a Claude session. Link it first if its session
    // started but the watcher hasn't seen the log yet.
    let chat = this.storageService.getChat(chatId);
    if (chat && !chat.claudeSessionId) {
      const cwd = (terminal.creationOptions as vscode.TerminalOptions).cwd;
      const worktreePath = typeof cwd === 'string' ? cwd : cwd?.fsPath;
      if (worktreePath) {
        chat = this.sessionWatcher.linkIfStarted(chatId, worktreePath, { requireConversation: true }) ?? chat;
      }
    }

    if (chat && !chat.claudeSessionId) {
      // Session was closed without any conversation - delete it
      this.storageService.deleteChat(chatId);
      vscode.commands.executeCommand('agntree.refreshWorkspaces');
    } else {
      // Update chat status
      this.storageService.updateChat(chatId, {
        status: 'closed',
      });
    }

    this._onTerminalStateChange.fire({ chatId, state: 'closed' });
  }

  /**
   * Get all active chat IDs
   */
  getActiveChatIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Dispose all terminals (for extension deactivation)
   */
  dispose(): void {
    this.onCloseTerminalDisposable.dispose();
    for (const terminal of this.terminals.values()) {
      terminal.dispose();
    }
    this.terminals.clear();
    this.terminalToChatId.clear();
    this._onTerminalStateChange.dispose();
  }

  /**
   * Sync terminals with existing VS Code terminals on activation
   * (Handles case where extension is reloaded but terminals are still open)
   */
  syncWithExistingTerminals(): void {
    const chats = this.storageService.getChats();
    const existingTerminals = vscode.window.terminals;

    // Build a map of short chat ID -> chat for quick lookup
    const chatsByShortId = new Map<string, typeof chats[0]>();
    for (const chat of chats) {
      const shortId = chat.id.substring(0, 6);
      chatsByShortId.set(shortId, chat);
    }

    // Check each existing terminal
    for (const terminal of existingTerminals) {
      // Parse the chat ID from the terminal name
      const shortId = TerminalManager.parseChatIdFromTerminalName(terminal.name);

      if (shortId) {
        const chat = chatsByShortId.get(shortId);

        if (chat) {
          // Re-register this terminal
          this.terminals.set(chat.id, terminal);
          this.terminalToChatId.set(terminal, chat.id);

          // Update chat status to active
          this.storageService.updateChat(chat.id, { status: 'active' });

          this._onTerminalStateChange.fire({ chatId: chat.id, state: 'opened' });
        }
      }
    }

    // Chats without a terminal here are left alone: they may be running in another
    // window on this machine, which shares the saved state.
  }
}
