import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Repository, ChatSession, STORAGE_KEYS, generateId } from '../types';
import { ClaudeSessionService } from './ClaudeSessionService';
import { LegacyState, PersistedState, StateStore, migrateLegacyState } from './StateStore';

/**
 * Saves repositories and sessions for this machine.
 *
 * The data lives in a JSON file under `context.globalStorageUri`. With Remote-SSH that
 * folder is on the remote machine (each Coder workspace has its own), unlike
 * `globalState`, which is stored on the VS Code client and shared by every machine it
 * connects to. Sharing it meant two workspaces with the same paths saw each other's
 * sessions, and deleting a "missing" session in one removed it from the other.
 */
export class StorageService implements vscode.Disposable {
  private readonly store: StateStore;
  private readonly watcher: { dispose(): void } | undefined;

  /** Per-window selection; not saved, so windows don't change each other's. */
  private activeChatId: string | undefined;
  private activeWorktreeId: string | undefined;

  private readonly _onDidChangeExternally = new vscode.EventEmitter<void>();
  /** Fires when another VS Code window on this machine changes the saved data. */
  readonly onDidChangeExternally = this._onDidChangeExternally.event;

  constructor(private context: vscode.ExtensionContext) {
    this.store = new StateStore(path.join(context.globalStorageUri.fsPath, 'state.json'));
    if (!this.store.exists()) {
      this.migrateFromGlobalState();
    }
    try {
      this.watcher = this.store.watch(() => this._onDidChangeExternally.fire());
    } catch (error) {
      console.error('Failed to watch the Agntree state file:', error);
    }
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChangeExternally.dispose();
  }

  /** One-time copy of what older versions saved in globalState, keeping only this machine's data. */
  private migrateFromGlobalState(): void {
    const globalState = this.context.globalState;
    const legacy: LegacyState = {
      repositories: globalState.get<Repository[]>(STORAGE_KEYS.REPOSITORIES),
      chats: globalState.get<ChatSession[]>(STORAGE_KEYS.CHATS),
      prWorktrees: globalState.get<Record<string, number>>(STORAGE_KEYS.PR_WORKTREES),
      starredChats: globalState.get<string[]>(STORAGE_KEYS.STARRED_CHATS),
    };
    let sessionIds: Set<string> | undefined;
    const state = migrateLegacyState(legacy, {
      pathExists: (p) => fs.existsSync(p),
      sessionExists: (id) => (sessionIds ??= new ClaudeSessionService().listSessionIds()).has(id),
    });
    try {
      // Another window starting at the same time may have migrated already.
      this.store.writeIfMissing(state);
    } catch (error) {
      console.error('Failed to save the Agntree state file:', error);
    }
    // globalState is left as it is: other machines still need it for their own migration.
  }

  private get state(): PersistedState {
    return this.store.read();
  }

  // ============ Repository Operations ============

  /**
   * Get all stored repositories (excluding hidden by default)
   */
  getRepositories(includeHidden: boolean = false): Repository[] {
    const all = this.state.repositories;
    return includeHidden ? [...all] : all.filter((r) => !r.hidden);
  }

  /**
   * Get hidden repositories only
   */
  getHiddenRepositories(): Repository[] {
    return this.state.repositories.filter((r) => r.hidden);
  }

  /**
   * Get a repository by ID
   */
  getRepository(id: string): Repository | undefined {
    return this.state.repositories.find((r) => r.id === id);
  }

  /**
   * Add a new repository (or unhide it if it was hidden)
   */
  addRepository(name: string, rootPath: string): Repository {
    return this.store.update((state) => {
      const existing = state.repositories.find((r) => r.rootPath === rootPath);
      if (existing) {
        existing.hidden = false;
        return existing;
      }
      const repo: Repository = { id: generateId(), name, rootPath, hidden: false };
      state.repositories.push(repo);
      return repo;
    });
  }

  /**
   * Hide a repository (soft remove - keeps data)
   */
  hideRepository(id: string): void {
    this.setHidden(id, true);
  }

  /**
   * Unhide a repository
   */
  unhideRepository(id: string): void {
    this.setHidden(id, false);
  }

  private setHidden(id: string, hidden: boolean): void {
    this.store.update((state) => {
      const repo = state.repositories.find((r) => r.id === id);
      if (repo) {
        repo.hidden = hidden;
      }
    });
  }

  /**
   * Remove a repository permanently (hard delete)
   */
  removeRepository(id: string): void {
    // Chat sessions are preserved - they can be re-imported if repo is re-added
    this.store.update((state) => {
      state.repositories = state.repositories.filter((r) => r.id !== id);
    });
  }

  // ============ Chat Operations ============

  /**
   * Get all stored chat sessions
   */
  getChats(): ChatSession[] {
    return [...this.state.chats];
  }

  /**
   * Get chats for a specific worktree
   */
  getChatsByWorktree(worktreeId: string): ChatSession[] {
    return this.state.chats.filter((c) => c.worktreeId === worktreeId);
  }

  /**
   * Get a chat by ID
   */
  getChat(id: string): ChatSession | undefined {
    return this.state.chats.find((c) => c.id === id);
  }

  /**
   * Create a new chat session
   */
  createChat(worktreeId: string, name: string, baseCommit: string | null = null): ChatSession {
    const chat: ChatSession = {
      id: generateId(),
      worktreeId,
      name,
      claudeSessionId: null,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      status: 'idle',
      baseCommit,
    };
    this.store.update((state) => {
      state.chats.push(chat);
    });
    return { ...chat };
  }

  /**
   * Update an existing chat session
   */
  updateChat(id: string, updates: Partial<ChatSession>): ChatSession | undefined {
    return this.store.update((state) => {
      const index = state.chats.findIndex((c) => c.id === id);
      if (index === -1) {
        return undefined;
      }
      state.chats[index] = { ...state.chats[index], ...updates };
      return { ...state.chats[index] };
    });
  }

  /**
   * Delete a chat session
   */
  deleteChat(id: string): void {
    this.store.update((state) => {
      state.chats = state.chats.filter((c) => c.id !== id);
    });
  }

  /**
   * Delete all chat sessions for a worktree
   * Returns the IDs of deleted chats
   */
  deleteChatsByWorktree(worktreeId: string): string[] {
    return this.store.update((state) => {
      const deletedIds = state.chats.filter((c) => c.worktreeId === worktreeId).map((c) => c.id);
      state.chats = state.chats.filter((c) => c.worktreeId !== worktreeId);
      return deletedIds;
    });
  }

  /**
   * Rename a chat session
   */
  renameChat(id: string, newName: string): ChatSession | undefined {
    return this.updateChat(id, { name: newName });
  }

  /**
   * Mark chat as accessed (updates lastAccessedAt)
   */
  touchChat(id: string): void {
    this.updateChat(id, { lastAccessedAt: Date.now() });
  }

  // ============ Active Chat ============

  /**
   * Get the currently active chat ID
   */
  getActiveChatId(): string | undefined {
    return this.activeChatId;
  }

  /**
   * Set the currently active chat
   */
  setActiveChatId(chatId: string | undefined): void {
    this.activeChatId = chatId;
  }

  /**
   * Get the currently active worktree ID
   */
  getActiveWorktreeId(): string | undefined {
    return this.activeWorktreeId;
  }

  /**
   * Set the currently active worktree ID
   */
  setActiveWorktreeId(worktreeId: string | undefined): void {
    this.activeWorktreeId = worktreeId;
  }

  // ============ PR Worktrees ============

  /**
   * Get PR number for a worktree (if it was checked out via PR checkout)
   */
  getPRWorktree(worktreeId: string): number | undefined {
    return this.state.prWorktrees[worktreeId];
  }

  /**
   * Mark a worktree as checked out from a PR
   */
  setPRWorktree(worktreeId: string, prNumber: number): void {
    this.store.update((state) => {
      state.prWorktrees[worktreeId] = prNumber;
    });
  }

  /**
   * Remove PR association for a worktree
   */
  removePRWorktree(worktreeId: string): void {
    this.store.update((state) => {
      delete state.prWorktrees[worktreeId];
    });
  }

  // ============ Starred Sessions ============

  getStarredChatIds(): Set<string> {
    return new Set(this.state.starredChats);
  }

  isStarred(chatId: string): boolean {
    return this.state.starredChats.includes(chatId);
  }

  toggleStar(chatId: string): boolean {
    return this.store.update((state) => {
      const nowStarred = !state.starredChats.includes(chatId);
      state.starredChats = nowStarred
        ? [...state.starredChats, chatId]
        : state.starredChats.filter((id) => id !== chatId);
      return nowStarred;
    });
  }

  getStarredChats(): ChatSession[] {
    const starredIds = this.getStarredChatIds();
    return this.state.chats.filter((c) => starredIds.has(c.id));
  }

  // ============ Cleanup ============

  /**
   * Remove orphaned chats (chats whose worktrees no longer exist)
   */
  cleanupOrphanedChats(validWorktreeIds: string[]): number {
    return this.store.update((state) => {
      const before = state.chats.length;
      state.chats = state.chats.filter((c) => validWorktreeIds.includes(c.worktreeId));
      return before - state.chats.length;
    });
  }
}
