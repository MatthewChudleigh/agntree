import * as fs from 'fs';
import type { StorageService } from './StorageService';
import { ClaudeSessionService } from './ClaudeSessionService';
import { ChatSession } from '../types';
import { SessionNamer } from '../utils/sessionLog';

interface PendingChat {
  sessionId: string;
  worktreePath: string;
}

/** The part of StorageService the watcher uses (so it can be tested without VS Code). */
export type ChatStore = Pick<StorageService, 'getChat' | 'getChats' | 'updateChat' | 'renameChat'>;

type NameListener = (event: { chatId: string; name: string }) => void;

/**
 * Links chats to the Claude Code sessions they start, and names chats after them.
 *
 * Every chat is started with an ID chosen in advance (`claude --session-id <id>`), so its
 * log is `<id>.jsonl` and nothing has to be guessed. (Matching the next new log in the
 * worktree's project folder linked chats to sessions other chats, Quick Actions or
 * other terminals had started.) Claude Code writes the log when the first prompt is
 * sent; until then the chat is pending and this polls for the file.
 */
export class SessionWatcher {
  private static readonly POLL_MS = 2000;
  /** How long to keep waiting for Claude Code to record a title after naming a chat from its first prompt. */
  private static readonly TITLE_WAIT_MS = 10 * 60 * 1000;
  /** Give up naming a chat if its log shows no prompt or title for this long. */
  private static readonly NAME_WAIT_MS = 30 * 60 * 1000;

  /** Pending chats by chat ID */
  private pending = new Map<string, PendingChat>();
  private poller: NodeJS.Timeout | undefined;
  private nameMonitors = new Map<string, NodeJS.Timeout>();
  private nameListeners = new Set<NameListener>();

  constructor(
    private storageService: ChatStore,
    private readonly sessions: ClaudeSessionService = new ClaudeSessionService()
  ) {}

  /** Call `listener` when a chat is renamed after its session. */
  onChatNameUpdated(listener: NameListener): { dispose(): void } {
    this.nameListeners.add(listener);
    return { dispose: () => this.nameListeners.delete(listener) };
  }

  /**
   * Pick up chats that were started but not linked before this window (re)loaded, e.g.
   * after an extension host restart. Their worktree paths come from `worktreePathOf`.
   */
  resumePending(worktreePathOf: (chat: ChatSession) => Promise<string | undefined>): void {
    for (const chat of this.storageService.getChats()) {
      if (!chat.claudeSessionId && chat.pendingSessionId) {
        const sessionId = chat.pendingSessionId;
        worktreePathOf(chat).then(
          (worktreePath) => worktreePath && this.watchForSession(chat.id, sessionId, worktreePath),
          () => undefined
        );
      }
    }
  }

  /** Wait for session `sessionId`, started in `worktreePath`, to write its log, then link it to the chat. */
  watchForSession(chatId: string, sessionId: string, worktreePath: string): void {
    this.pending.set(chatId, { sessionId, worktreePath });
    if (!this.poller) {
      this.poller = setInterval(() => this.poll(), SessionWatcher.POLL_MS);
    }
  }

  /**
   * Link the chat now if its session has written a log. Returns the updated chat, or
   * undefined if it hasn't started (or the chat no longer exists).
   * @param requireConversation only link a log that holds a prompt or reply
   */
  linkIfStarted(chatId: string, worktreePath: string, options: { requireConversation?: boolean } = {}): ChatSession | undefined {
    const chat = this.storageService.getChat(chatId);
    if (!chat) {
      this.pending.delete(chatId);
      return undefined;
    }
    if (chat.claudeSessionId) {
      this.pending.delete(chatId);
      return chat;
    }
    const sessionId = chat.pendingSessionId;
    if (!sessionId) {
      return undefined;
    }
    const logPath = this.sessions.findSessionLog(sessionId, worktreePath);
    if (!logPath || (options.requireConversation && !this.sessions.isSessionResumable(sessionId))) {
      return undefined;
    }
    const linked = this.storageService.updateChat(chatId, {
      claudeSessionId: sessionId,
      pendingSessionId: undefined,
      forkFromSessionId: undefined,
    });
    this.pending.delete(chatId);
    this.monitorSessionForName(chatId, logPath);
    console.log(`[SessionWatcher] Linked session ${sessionId} to chat ${chatId}`);
    return linked;
  }

  private poll(): void {
    for (const [chatId, pending] of [...this.pending]) {
      const chat = this.storageService.getChat(chatId);
      if (!chat || chat.claudeSessionId || chat.pendingSessionId !== pending.sessionId) {
        // Deleted, linked by another window, or restarted with a different ID
        this.pending.delete(chatId);
        continue;
      }
      this.linkIfStarted(chatId, pending.worktreePath);
    }
    if (this.pending.size === 0 && this.poller) {
      clearInterval(this.poller);
      this.poller = undefined;
    }
  }

  /**
   * Monitor a session file for its name. The first prompt names the chat as soon as it is
   * typed; Claude Code's own title (a `custom-title` entry, written shortly afterwards)
   * replaces it, unless the user has renamed the chat in the meantime.
   */
  private monitorSessionForName(chatId: string, sessionFilePath: string): void {
    // Clear any existing interval for this chat
    const existingInterval = this.nameMonitors.get(chatId);
    if (existingInterval) {
      clearInterval(existingInterval);
    }

    const startedAt = Date.now();
    let autoName: string | undefined;
    let namedAt = 0;
    const stop = () => {
      clearInterval(checkInterval);
      this.nameMonitors.delete(chatId);
    };
    const rename = (name: string) => {
      this.storageService.renameChat(chatId, name);
      for (const listener of this.nameListeners) {
        listener({ chatId, name });
      }
    };

    const checkInterval = setInterval(() => {
      const chat = this.storageService.getChat(chatId);
      const stillAutoNamed = chat && (chat.name.startsWith('New Session') || chat.name === autoName);

      // Stop if the chat was deleted or renamed by the user. (Not on its stored status:
      // that is shared by every window on this machine, and another window resets it.)
      if (!chat || !stillAutoNamed) {
        stop();
        return;
      }

      const namer = this.readNames(sessionFilePath);
      const name = namer?.name;
      if (namer?.hasTitle && name) {
        if (name !== chat.name) {
          rename(name);
        }
        stop();
      } else if (name && autoName === undefined) {
        autoName = name;
        namedAt = Date.now();
        rename(name);
      } else if (autoName !== undefined && Date.now() - namedAt > SessionWatcher.TITLE_WAIT_MS) {
        stop(); // named from the first prompt; Claude Code never recorded a title
      } else if (autoName === undefined && Date.now() - startedAt > SessionWatcher.NAME_WAIT_MS) {
        stop();
      }
    }, 5000);

    this.nameMonitors.set(chatId, checkInterval);
  }

  /** Read a session log's title and first prompt. */
  private readNames(filePath: string): SessionNamer | null {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }

      // Read only a bounded prefix. The title and first user prompt appear near the
      // top of the log, and this runs on a 5s poll, so we must not read a whole large file.
      const maxBytes = 512 * 1024;
      const fd = fs.openSync(filePath, 'r');
      let content: string;
      let truncated: boolean;
      try {
        const buf = Buffer.alloc(maxBytes);
        const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
        content = buf.subarray(0, bytesRead).toString('utf-8');
        truncated = bytesRead >= maxBytes;
      } finally {
        fs.closeSync(fd);
      }
      const rawLines = content.split('\n');
      // Drop a trailing partial line if we hit the byte cap.
      const lines = truncated ? rawLines.slice(0, -1) : rawLines;

      const namer = new SessionNamer();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          namer.add(JSON.parse(line));
        } catch {
          // Skip invalid JSON
        }
      }
      return namer;
    } catch {
      return null;
    }
  }

  /**
   * Stop watching and clean up
   */
  dispose(): void {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = undefined;
    }
    this.pending.clear();

    for (const interval of this.nameMonitors.values()) {
      clearInterval(interval);
    }
    this.nameMonitors.clear();
    this.nameListeners.clear();
  }
}
