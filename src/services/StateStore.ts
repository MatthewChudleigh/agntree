import * as fs from 'fs';
import * as path from 'path';
import { ChatSession, Repository } from '../types';

/** Everything Agntree saves about this machine's repositories and sessions. */
export interface PersistedState {
  version: 1;
  repositories: Repository[];
  chats: ChatSession[];
  /** PR number by worktree ID, for worktrees made by Checkout PR */
  prWorktrees: Record<string, number>;
  starredChats: string[];
}

export function emptyState(): PersistedState {
  return { version: 1, repositories: [], chats: [], prWorktrees: {}, starredChats: [] };
}

/** State saved by older versions in VS Code's globalState. */
export interface LegacyState {
  repositories?: Repository[];
  chats?: ChatSession[];
  prWorktrees?: Record<string, number>;
  starredChats?: string[];
}

/**
 * Build this machine's state from what older versions saved in globalState. globalState
 * lives on the VS Code client and is shared by every machine it connects to (each Coder
 * workspace, the local machine, ...), so keep only what belongs here: repositories whose
 * folder exists on this machine, and sessions whose Claude Code log is on this machine.
 */
export function migrateLegacyState(
  legacy: LegacyState,
  here: { pathExists: (p: string) => boolean; sessionExists: (sessionId: string) => boolean }
): PersistedState {
  const repositories = (legacy.repositories ?? []).filter((repo) => here.pathExists(repo.rootPath));
  const chats = (legacy.chats ?? [])
    .filter((chat) => chat.claudeSessionId !== null && here.sessionExists(chat.claudeSessionId))
    .map((chat) => ({ ...chat, status: 'idle' as const }));
  const chatIds = new Set(chats.map((chat) => chat.id));
  return {
    version: 1,
    repositories,
    chats,
    prWorktrees: { ...(legacy.prWorktrees ?? {}) },
    starredChats: (legacy.starredChats ?? []).filter((id) => chatIds.has(id)),
  };
}

/**
 * Copy the state file another extension ID saved (`source`) into `target`, if `target` has
 * none yet. The extension's storage folder is named after its ID, so renaming the ID (this
 * fork was `subhashkhileri.agntree`) would otherwise start with nothing saved. Returns whether
 * it copied. A source that isn't valid JSON is left alone and nothing is copied.
 */
export function adoptStateFile(source: string, target: StateStore): boolean {
  if (target.exists() || path.resolve(source) === path.resolve(target.filePath)) {
    return false;
  }
  let parsed: Partial<PersistedState>;
  try {
    parsed = JSON.parse(fs.readFileSync(source, 'utf-8')) as Partial<PersistedState>;
  } catch {
    return false;
  }
  return target.writeIfMissing({ ...emptyState(), ...parsed, version: 1 });
}

/** Errors that Windows reports briefly while another process opens or replaces a file. */
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE']);

/** Block for a few milliseconds. Only used while waiting on another window's save. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/**
 * A JSON file holding {@link PersistedState}, shared by every VS Code window on this
 * machine. Each change takes a lock file, re-reads the file, and writes it atomically
 * (temporary file + rename), so windows saving at the same time don't lose each other's
 * changes and never read a half-written file.
 */
export class StateStore {
  /** How long a change waits for another window's lock before giving up. */
  private static readonly LOCK_WAIT_MS = 3000;
  /** A lock older than this was left by a window that crashed mid-save. */
  private static readonly STALE_LOCK_MS = 10_000;

  private cache: PersistedState | undefined;
  /** Identity, mtime and size of the file when `cache` was read or written */
  private cacheStamp: string | undefined;

  constructor(readonly filePath: string) {}

  private get lockPath(): string {
    return `${this.filePath}.lock`;
  }

  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  /**
   * The current state, re-read only when another window has changed the file. If the file
   * can't be read right now, returns the last state read (or an empty one) without caching
   * it, so the next call tries again.
   */
  read(): PersistedState {
    const stamp = this.stamp();
    if (this.cache && stamp === this.cacheStamp) {
      return this.cache;
    }
    try {
      this.cache = this.load();
      this.cacheStamp = stamp;
      return this.cache;
    } catch (error) {
      console.error('Failed to read the Agntree state file:', error);
      return this.cache ?? emptyState();
    }
  }

  /**
   * Apply `change` to the latest saved state and save it. Returns `change`'s result.
   * Throws, without saving, if the file can't be read or another window holds the lock.
   */
  update<T>(change: (state: PersistedState) => T): T {
    return this.withLock(() => {
      const state = this.load();
      const result = change(state);
      this.save(state);
      return result;
    });
  }

  /** Save `state` as the whole file if no file exists yet (the one-time migration). */
  writeIfMissing(state: PersistedState): boolean {
    return this.withLock(() => {
      if (this.exists()) {
        return false;
      }
      this.save(state);
      return true;
    });
  }

  /** Replace the whole file with `state`. */
  write(state: PersistedState): void {
    this.withLock(() => this.save(state));
  }

  /**
   * Call `onChange` when another window changes the file. Changes this store makes
   * itself are ignored.
   */
  watch(onChange: () => void): { dispose(): void } {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(this.filePath);
    let timer: NodeJS.Timeout | undefined;
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (filename && filename !== name) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (this.stamp() !== this.cacheStamp) {
          onChange();
        }
      }, 100);
    });
    watcher.on('error', () => undefined);
    return {
      dispose: () => {
        clearTimeout(timer);
        watcher.close();
      },
    };
  }

  /** Run `action` holding the lock file, which only one process can create at a time. */
  private withLock<T>(action: () => T): T {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + StateStore.LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.closeSync(fs.openSync(this.lockPath, 'wx'));
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST' && !TRANSIENT.has(errorCode(error) ?? '')) {
          throw error;
        }
        if (this.lockIsStale()) {
          fs.rmSync(this.lockPath, { force: true });
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`The Agntree state file is locked by another window (${this.lockPath}).`);
        }
        pause(5);
      }
    }
    try {
      return action();
    } finally {
      fs.rmSync(this.lockPath, { force: true });
    }
  }

  private lockIsStale(): boolean {
    try {
      return Date.now() - fs.statSync(this.lockPath).mtimeMs > StateStore.STALE_LOCK_MS;
    } catch {
      return false; // released meanwhile
    }
  }

  /** Write `state` to a temporary file and rename it over the state file. Call holding the lock. */
  private save(state: PersistedState): void {
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(temp, this.filePath);
        break;
      } catch (error) {
        // Windows refuses to replace a file another process is reading at that moment.
        if (!TRANSIENT.has(errorCode(error) ?? '') || attempt >= 20) {
          fs.rmSync(temp, { force: true });
          throw error;
        }
        pause(10);
      }
    }
    this.cache = state;
    this.cacheStamp = this.stamp();
  }

  private stamp(): string | undefined {
    try {
      const stats = fs.statSync(this.filePath);
      // The inode changes on every save (each is a rename of a new file), so a save that
      // keeps the same size within the same mtime tick is still noticed.
      return `${stats.ino}:${stats.mtimeMs}:${stats.size}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Read and parse the file. A missing file is an empty state. Any other read error
   * throws, so a change is never saved over data that couldn't be read. A file that
   * isn't valid JSON is moved aside (it can't be half-written: saves are renames).
   */
  private load(): PersistedState {
    let text: string;
    for (let attempt = 1; ; attempt++) {
      try {
        text = fs.readFileSync(this.filePath, 'utf-8');
        break;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          return emptyState();
        }
        if (!TRANSIENT.has(errorCode(error) ?? '') || attempt >= 20) {
          throw error;
        }
        pause(10);
      }
    }
    try {
      const parsed = JSON.parse(text) as Partial<PersistedState>;
      return { ...emptyState(), ...parsed, version: 1 };
    } catch (error) {
      // Keep the unreadable file for inspection rather than overwriting it on the next save.
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      console.error(`Agntree state file is not valid JSON; moving it to ${backup}:`, error);
      try {
        fs.renameSync(this.filePath, backup);
      } catch {
        // Another window moved or replaced it first.
      }
      return emptyState();
    }
  }
}
