import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isWithin } from '../utils/paths';
import { claudeConfigDir } from '../utils/sessionLog';

/** A Claude Code process running on this machine, started from anywhere (VS Code, a shell, the desktop app). */
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Display name, if the session has one */
  name: string | null;
  /** e.g. `busy` or `idle` */
  status: string | null;
}

/** Read the entries of `claude agents --json`, or of one `<configDir>/sessions/<pid>.json` file. */
export function parseLiveSessions(value: unknown): LiveSession[] {
  const entries = Array.isArray(value) ? value : [value];
  const sessions: LiveSession[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const { pid, sessionId, cwd, name, status } = entry as Record<string, unknown>;
    if (typeof sessionId !== 'string' || !sessionId || typeof cwd !== 'string' || !cwd) {
      continue;
    }
    sessions.push({
      pid: typeof pid === 'number' ? pid : 0,
      sessionId,
      cwd,
      name: typeof name === 'string' && name.trim() ? name.trim() : null,
      status: typeof status === 'string' && status ? status : null,
    });
  }
  return sessions;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LiveSessionOptions {
  /** Claude Code's config folder; defaults to `claudeConfigDir()` */
  configDir?: string;
  /** The Claude Code executable; defaults to `claude` */
  command?: string;
  isAlive?: (pid: number) => boolean;
}

/**
 * Lists the Claude Code sessions running on this machine, so Agntree can tell when a
 * session is already open somewhere else (another VS Code window, the desktop app over
 * SSH, a plain terminal) before resuming it again or deleting the folder it runs in.
 *
 * Uses `claude agents --json`. If that can't run (for example `claude` is only on the
 * PATH of interactive shells, which the extension host may not have), it reads the
 * registry that command is built on, `<configDir>/sessions/<pid>.json`, and keeps the
 * entries whose process is still running.
 */
export class LiveSessionService {
  private static readonly CACHE_MS = 3000;
  private cache: { at: number; sessions: Promise<LiveSession[] | null> } | undefined;

  constructor(private readonly options: LiveSessionOptions = {}) {}

  /** Running sessions, or null if they couldn't be listed. Cached for a few seconds. */
  list(): Promise<LiveSession[] | null> {
    if (this.cache && Date.now() - this.cache.at < LiveSessionService.CACHE_MS) {
      return this.cache.sessions;
    }
    const sessions = this.fromCli().catch(() => this.fromRegistry());
    this.cache = { at: Date.now(), sessions };
    return sessions;
  }

  /** The running process for a session, if there is one. */
  async find(sessionId: string): Promise<LiveSession | undefined> {
    return (await this.list())?.find((session) => session.sessionId === sessionId);
  }

  /** Running sessions whose working directory is `dir` or inside it. */
  async within(dir: string): Promise<LiveSession[]> {
    return ((await this.list()) ?? []).filter((session) => isWithin(dir, session.cwd));
  }

  private fromCli(): Promise<LiveSession[]> {
    return new Promise((resolve, reject) => {
      execFile(
        this.options.command ?? 'claude',
        ['agents', '--json'],
        // Runs when a session is clicked, so don't wait long; the registry is the fallback.
        { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          try {
            resolve(parseLiveSessions(JSON.parse(stdout)));
          } catch (parseError) {
            reject(parseError);
          }
        }
      );
    });
  }

  private async fromRegistry(): Promise<LiveSession[] | null> {
    const dir = path.join(this.options.configDir ?? claudeConfigDir(), 'sessions');
    let files: string[];
    try {
      files = await fs.promises.readdir(dir);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
    }
    const isAlive = this.options.isAlive ?? processIsAlive;
    const sessions: LiveSession[] = [];
    // Only `<pid>.json`. The `<pid>.<hash>.key` files next to them hold secrets.
    for (const file of files.filter((name) => /^\d+\.json$/.test(name))) {
      try {
        const text = await fs.promises.readFile(path.join(dir, file), 'utf-8');
        sessions.push(...parseLiveSessions(JSON.parse(text)).filter((session) => session.pid > 0 && isAlive(session.pid)));
      } catch {
        // Removed while we read it, or half-written: skip it.
      }
    }
    return sessions;
  }
}
