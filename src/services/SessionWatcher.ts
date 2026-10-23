import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { StorageService } from './StorageService';
import { Worktree } from '../types';
import { SessionNamer, claudeConfigDir } from '../utils/sessionLog';

interface PendingChat {
  chatId: string;
  worktreePath: string;
  createdAt: number;
}

/**
 * Watches for new Claude Code sessions and auto-links them to pending chats.
 * Monitors .jsonl files directly since sessions-index.json may not update immediately.
 */
export class SessionWatcher {
  private projectsDir: string;
  private projectWatchers: Map<string, fs.FSWatcher> = new Map();
  private pendingChats: PendingChat[] = [];
  private monitoringIntervals: Map<string, NodeJS.Timeout> = new Map();
  private knownSessions: Set<string> = new Set();

  /** Event emitter for when a chat name is updated */
  private _onChatNameUpdated = new vscode.EventEmitter<{ chatId: string; name: string }>();
  public readonly onChatNameUpdated = this._onChatNameUpdated.event;

  constructor(private storageService: StorageService) {
    this.projectsDir = path.join(claudeConfigDir(), 'projects');
  }

  private isSessionFile(filename: string): boolean {
    return filename.endsWith('.jsonl') && !filename.startsWith('agent-');
  }

  /**
   * Start watching for new Claude sessions
   */
  startWatching(): void {
    if (!fs.existsSync(this.projectsDir)) {
      console.log('Claude projects directory does not exist yet');
      return;
    }

    // Catalog all existing sessions so we know what's new
    this.catalogExistingSessions();
    this.watchExistingProjectDirs();
  }

  /**
   * Build a set of all existing session IDs
   */
  private catalogExistingSessions(): void {
    try {
      const dirs = fs.readdirSync(this.projectsDir)
        .filter(name => !name.startsWith('.'))
        .map(name => path.join(this.projectsDir, name))
        .filter(p => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        });

      for (const dir of dirs) {
        try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (this.isSessionFile(file)) {
              const sessionId = file.replace('.jsonl', '');
              this.knownSessions.add(sessionId);
            }
          }
        } catch {
          // Skip directories we can't read
        }
      }
      console.log(`Cataloged ${this.knownSessions.size} existing sessions`);
    } catch (error) {
      console.error('Failed to catalog existing sessions:', error);
    }
  }

  /**
   * Watch all existing project directories for new session files
   */
  private watchExistingProjectDirs(): void {
    try {
      const dirs = fs.readdirSync(this.projectsDir)
        .filter(name => !name.startsWith('.'))
        .map(name => path.join(this.projectsDir, name))
        .filter(p => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        });

      for (const dir of dirs) {
        this.watchProjectDir(dir);
      }
    } catch (error) {
      console.error('Failed to watch existing project dirs:', error);
    }
  }

  /**
   * Watch a project directory for new session files
   */
  private watchProjectDir(dirPath: string): void {
    if (this.projectWatchers.has(dirPath)) {
      return; // Already watching
    }

    try {
      const watcher = fs.watch(dirPath, { persistent: false }, (_eventType, filename) => {
        if (filename && this.isSessionFile(filename)) {
          const sessionId = filename.replace('.jsonl', '');

          // Only process sessions we haven't seen before
          if (!this.knownSessions.has(sessionId)) {
            this.knownSessions.add(sessionId);
            const filePath = path.join(dirPath, filename);
            this.handleNewSession(filePath, sessionId, dirPath);
          }
        }
      });

      this.projectWatchers.set(dirPath, watcher);
    } catch (error) {
      console.error(`Failed to watch project dir ${dirPath}:`, error);
    }
  }

  /**
   * Handle a newly created session file
   */
  private handleNewSession(filePath: string, sessionId: string, projectDir: string): void {
    if (this.pendingChats.length === 0) {
      return;
    }

    // Use the project directory name to match pending chats
    // This is more reliable than parsing cwd from the session file, which may only have snapshot entries
    const projectDirName = path.basename(projectDir);
    this.linkSessionToChatByProjectDir(filePath, sessionId, projectDirName);
  }

  /**
   * Try to link a session to a pending chat using project directory name
   * This matches the encoded worktree path to the project directory name
   */
  private linkSessionToChatByProjectDir(filePath: string, sessionId: string, projectDirName: string): void {
    // Find a matching pending chat by comparing encoded paths
    for (let i = this.pendingChats.length - 1; i >= 0; i--) {
      const pending = this.pendingChats[i];
      const encodedWorktreePath = this.encodeProjectPath(pending.worktreePath);

      // Check if the encoded worktree path matches the project directory name
      if (encodedWorktreePath === projectDirName) {
        // Found a match! Link the session to the chat
        const chat = this.storageService.getChat(pending.chatId);
        if (chat && !chat.claudeSessionId) {
          this.storageService.updateChat(pending.chatId, {
            claudeSessionId: sessionId,
          });

          // Remove from pending
          this.pendingChats.splice(i, 1);

          // Start monitoring for name updates
          this.monitorSessionForName(pending.chatId, filePath);

          console.log(`[SessionWatcher] Linked session ${sessionId} to chat ${pending.chatId}`);
          return;
        }
      }
    }
  }

  /**
   * Register a chat as pending for session linkage
   */
  registerPendingChat(chatId: string, worktree: Worktree): void {
    // Remove any existing pending entry for this chat
    this.pendingChats = this.pendingChats.filter(p => p.chatId !== chatId);

    this.pendingChats.push({
      chatId,
      worktreePath: worktree.path,
      createdAt: Date.now(),
    });

    // Ensure we're watching the correct project directory
    const encodedPath = this.encodeProjectPath(worktree.path);
    const projectDir = path.join(this.projectsDir, encodedPath);
    if (fs.existsSync(projectDir)) {
      this.watchProjectDir(projectDir);
      this.scanForUnlinkedSessions(projectDir);
    } else {
      // Directory doesn't exist yet — retry until it appears or chat is no longer active
      const retryInterval = setInterval(() => {
        const chat = this.storageService.getChat(chatId);
        if (!chat || chat.status !== 'active') {
          clearInterval(retryInterval);
          return;
        }
        if (fs.existsSync(projectDir)) {
          clearInterval(retryInterval);
          this.watchProjectDir(projectDir);
          this.scanForUnlinkedSessions(projectDir);
        }
      }, 5000);
      this.monitoringIntervals.set(`dir-${chatId}`, retryInterval);
    }

    this.ensurePendingChatPoller(projectDir);

    // Clean up old pending chats (older than 5 minutes)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    this.pendingChats = this.pendingChats.filter(p => p.createdAt > fiveMinutesAgo);
  }

  /** Scan for recent session files that weren't caught by fs.watch. */
  private scanForUnlinkedSessions(dirPath: string): void {
    if (this.pendingChats.length === 0) {
      return;
    }

    try {
      const files = fs.readdirSync(dirPath);
      const projectDirName = path.basename(dirPath);
      // Only consider files created in the last 2 minutes
      const cutoff = Date.now() - 2 * 60 * 1000;

      for (const file of files) {
        if (!this.isSessionFile(file)) {
          continue;
        }
        const filePath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.birthtimeMs < cutoff) {
            continue;
          }
        } catch {
          continue;
        }
        const sessionId = file.replace('.jsonl', '');
        this.knownSessions.add(sessionId);
        this.linkSessionToChatByProjectDir(filePath, sessionId, projectDirName);
      }
    } catch {
      // Directory may not be readable yet
    }
  }

  /**
   * Polling fallback — fs.watch on macOS can miss or coalesce events.
   */
  private ensurePendingChatPoller(projectDir: string): void {
    const pollerKey = `poller-${projectDir}`;
    if (this.monitoringIntervals.has(pollerKey)) {
      return;
    }

    const projectDirName = path.basename(projectDir);
    const poller = setInterval(() => {
      const hasPendingForDir = this.pendingChats.some(
        p => this.encodeProjectPath(p.worktreePath) === projectDirName
      );
      if (!hasPendingForDir) {
        clearInterval(poller);
        this.monitoringIntervals.delete(pollerKey);
        return;
      }

      this.scanForUnlinkedSessions(projectDir);
    }, 5000);

    this.monitoringIntervals.set(pollerKey, poller);
  }

  /**
   * Encode a path to match Claude's project directory naming.
   * Claude Code replaces every non-alphanumeric character with a dash (including the
   * Windows drive colon and spaces), so matching only separators and dots would never
   * line up with the real folder name.
   */
  private encodeProjectPath(projectPath: string): string {
    const normalizedPath = path.resolve(projectPath);
    return normalizedPath.replace(/[^a-zA-Z0-9]/g, '-');
  }

  /** How long to keep waiting for Claude Code to record a title after naming a chat from its first prompt. */
  private static readonly TITLE_WAIT_MS = 10 * 60 * 1000;

  /**
   * Monitor a session file for its name. The first prompt names the chat as soon as it is
   * typed; Claude Code's own title (a `custom-title` entry, written shortly afterwards)
   * replaces it, unless the user has renamed the chat in the meantime.
   */
  private monitorSessionForName(chatId: string, sessionFilePath: string): void {
    // Clear any existing interval for this chat
    const existingInterval = this.monitoringIntervals.get(chatId);
    if (existingInterval) {
      clearInterval(existingInterval);
    }

    let autoName: string | undefined;
    let namedAt = 0;
    const stop = () => {
      clearInterval(checkInterval);
      this.monitoringIntervals.delete(chatId);
    };
    const rename = (name: string) => {
      this.storageService.renameChat(chatId, name);
      this._onChatNameUpdated.fire({ chatId, name });
    };

    const checkInterval = setInterval(() => {
      const chat = this.storageService.getChat(chatId);
      const stillAutoNamed = chat && (chat.name.startsWith('New Session') || chat.name === autoName);

      // Stop if chat was deleted, renamed by the user, or session is no longer running
      if (!chat || !stillAutoNamed || chat.status !== 'active') {
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
      }
    }, 5000);

    this.monitoringIntervals.set(chatId, checkInterval);
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
    for (const watcher of this.projectWatchers.values()) {
      watcher.close();
    }
    this.projectWatchers.clear();

    for (const interval of this.monitoringIntervals.values()) {
      clearInterval(interval);
    }
    this.monitoringIntervals.clear();

    this._onChatNameUpdated.dispose();
  }
}
