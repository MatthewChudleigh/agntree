import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { isWithin } from '../utils/paths';
import { SessionNamer, claudeConfigDir, promptText } from '../utils/sessionLog';

/**
 * Claude Code may shorten very long project folder names, so prefix matching compares at
 * most this many characters. Comparing fewer only means a few extra folders are read.
 */
const MAX_PREFIX_LENGTH = 200;

/**
 * Represents an existing Claude Code session discovered from ~/.claude/projects
 */
export interface ClaudeSession {
  /** Session UUID (filename without .jsonl) */
  sessionId: string;
  /** Working directory where session was created */
  cwd: string;
  /** Session summary/description (if available) */
  summary: string | null;
  /** Latest recap from away_summary entries (if available) */
  recap: string | null;
  /** Git branch (if available) */
  gitBranch: string | null;
  /** Timestamp of last message */
  lastUpdated: Date | null;
  /** Path to the session file */
  filePath: string;
  /** Number of messages in session */
  messageCount: number;
}

/**
 * Service for discovering existing Claude Code sessions
 */
export class ClaudeSessionService {
  private claudeDir: string;
  private projectsDir: string;

  /** Cache of parsed sessions keyed by file path, invalidated by mtime/size. */
  private parseCache = new Map<string, { mtimeMs: number; size: number; session: ClaudeSession | null }>();

  /** Where each session's log was last found, so lookups don't re-scan every project folder. */
  private sessionFiles = new Map<string, string>();

  constructor() {
    this.claudeDir = claudeConfigDir();
    this.projectsDir = path.join(this.claudeDir, 'projects');
  }

  /**
   * Read a file line-by-line off the event loop. `onLine` may return `true` to stop early.
   * Streaming (instead of readFileSync + split) avoids allocating whole multi-MB session
   * logs and, crucially, keeps the VS Code extension host responsive while they are scanned.
   */
  private streamLines(filePath: string, onLine: (line: string) => boolean | void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        rl.close();
        stream.destroy();
        if (err) { reject(err); } else { resolve(); }
      };
      rl.on('line', (line) => {
        if (done) return;
        try {
          if (onLine(line) === true) { finish(); }
        } catch (e) {
          finish(e as Error);
        }
      });
      rl.on('close', () => finish());
      stream.on('error', (e) => finish(e));
    });
  }

  /**
   * Locate the session file for a session ID by scanning project directories.
   * Robust against path-encoding edge cases and forked sessions.
   */
  private findSessionFilePath(sessionId: string): string | null {
    const known = this.sessionFiles.get(sessionId);
    if (known && fs.existsSync(known)) {
      return known;
    }
    for (const dir of this.getProjectDirs()) {
      const fp = path.join(dir, `${sessionId}.jsonl`);
      if (fs.existsSync(fp)) {
        this.sessionFiles.set(sessionId, fp);
        return fp;
      }
    }
    return null;
  }

  /**
   * Project folders that can hold sessions started in or below any of `cwds`. Claude Code
   * names each folder after the session's starting directory, so a session started
   * anywhere inside a path is in a folder whose name starts with that path's encoding.
   */
  private getProjectDirsFor(cwds: string[]): string[] {
    const foldCase = process.platform === 'win32' || process.platform === 'darwin';
    const normalize = (name: string) => (foldCase ? name.toLowerCase() : name);
    const prefixes = cwds.map((cwd) => normalize(this.encodeProjectPath(cwd)).slice(0, MAX_PREFIX_LENGTH));
    return this.getProjectDirs().filter((dir) => {
      const name = normalize(path.basename(dir));
      return prefixes.some((prefix) => name.startsWith(prefix));
    });
  }

  /** IDs of every session log on this machine (file names only; nothing is parsed). */
  listSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const dir of this.getProjectDirs()) {
      try {
        for (const file of fs.readdirSync(dir)) {
          if (file.endsWith('.jsonl') && !file.startsWith('agent-')) {
            ids.add(file.slice(0, -'.jsonl'.length));
          }
        }
      } catch {
        // Skip folders we can't read
      }
    }
    return ids;
  }

  /**
   * Check if Claude Code is installed (has a .claude directory)
   */
  isClaudeInstalled(): boolean {
    return fs.existsSync(this.claudeDir);
  }

  /**
   * Get all project directories
   */
  getProjectDirs(): string[] {
    if (!fs.existsSync(this.projectsDir)) {
      return [];
    }

    try {
      return fs.readdirSync(this.projectsDir)
        .filter(name => !name.startsWith('.'))
        .map(name => path.join(this.projectsDir, name))
        .filter(p => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  }

  /**
   * Get all sessions in a project directory
   */
  private async getSessionsInDir(projectDir: string): Promise<ClaudeSession[]> {
    const sessions: ClaudeSession[] = [];

    let files: string[];
    try {
      files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
    } catch {
      return [];
    }

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const sessionId = file.replace('.jsonl', '');
      if (!this.sessionFiles.has(sessionId)) {
        this.sessionFiles.set(sessionId, filePath);
      }

      try {
        const session = await this.parseSessionFile(filePath, sessionId);
        if (session) {
          sessions.push(session);
        }
      } catch (err) {
        // Skip files that can't be parsed
        console.error(`Failed to parse session ${file}:`, err);
      }
    }

    return sessions;
  }

  /**
   * Parse a session file to extract metadata.
   * Streamed (not readFileSync) so large logs don't block the event loop, and cached
   * by file mtime/size so repeated scans (search, import, tooltips) stay cheap.
   */
  private async parseSessionFile(filePath: string, sessionId: string): Promise<ClaudeSession | null> {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return null;
    }

    // Skip empty files
    if (stats.size === 0) {
      return null;
    }

    const cached = this.parseCache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.session;
    }

    const session: ClaudeSession = {
      sessionId,
      cwd: '',
      summary: null,
      recap: null,
      gitBranch: null,
      lastUpdated: stats.mtime,
      filePath,
      messageCount: 0,
    };

    const namer = new SessionNamer();
    let latestRecapTimestamp = 0;

    try {
      await this.streamLines(filePath, (line) => {
        if (!line.trim()) return;

        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line);
        } catch {
          return; // Skip invalid JSON lines
        }

        // Name: the latest recorded title, else the first prompt the user typed
        namer.add(entry);

        // Get recap from away_summary entries — keep the most recent by timestamp
        if (entry.type === 'system' && entry.subtype === 'away_summary' && entry.content) {
          const ts = entry.timestamp ? new Date(entry.timestamp as string).getTime() : 0;
          if (ts >= latestRecapTimestamp) {
            latestRecapTimestamp = ts;
            // Strip the trailing "(disable recaps in /config)" hint
            session.recap = (entry.content as string).replace(/\s*\(disable recaps in \/config\)\s*$/, '').trim();
          }
        }

        // Get cwd and branch from user/assistant messages
        if (entry.cwd && !session.cwd) {
          session.cwd = entry.cwd as string;
        }

        if (entry.gitBranch && !session.gitBranch) {
          session.gitBranch = entry.gitBranch as string;
        }

        // Count messages
        if (entry.type === 'user' || entry.type === 'assistant') {
          session.messageCount++;
        }
      });
    } catch {
      return null;
    }

    session.summary = namer.name;

    // Skip sessions without a working directory
    const result = session.cwd ? session : null;
    this.parseCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, session: result });
    return result;
  }

  /**
   * Get all sessions across all projects
   */
  async getAllSessionsFlat(): Promise<ClaudeSession[]> {
    return this.getSessionsInDirs(this.getProjectDirs());
  }

  /** Sessions in the given project folders, most recently updated first. */
  private async getSessionsInDirs(projectDirs: string[]): Promise<ClaudeSession[]> {
    const allSessions: ClaudeSession[] = [];

    for (const dir of projectDirs) {
      const sessions = await this.getSessionsInDir(dir);
      allSessions.push(...sessions);
    }

    // Sort by last updated, most recent first
    allSessions.sort((a, b) => {
      if (!a.lastUpdated) return 1;
      if (!b.lastUpdated) return -1;
      return b.lastUpdated.getTime() - a.lastUpdated.getTime();
    });

    return allSessions;
  }

  /**
   * Find sessions matching a worktree path
   * Matches sessions where the session's cwd equals or starts with the worktree path
   */
  async findSessionsForWorktree(worktreePath: string): Promise<ClaudeSession[]> {
    return this.findSessionsUnder([worktreePath]);
  }

  /**
   * Find all sessions related to a repository (main worktree + all worktrees)
   * Matches sessions whose cwd equals or is a subdirectory of any provided path
   */
  async findSessionsForRepository(repoRootPath: string, worktreePaths: string[]): Promise<ClaudeSession[]> {
    return this.findSessionsUnder([repoRootPath, ...worktreePaths]);
  }

  /**
   * Sessions started in or below any of `paths`. Only the project folders named after those
   * paths are read, not every session log on the machine (which can be gigabytes).
   */
  private async findSessionsUnder(paths: string[]): Promise<ClaudeSession[]> {
    const sessions = await this.getSessionsInDirs(this.getProjectDirsFor(paths));
    return sessions.filter((session) => paths.some((p) => isWithin(p, session.cwd)));
  }

  /**
   * Get sessions grouped by their cwd
   */
  async getSessionsGroupedByCwd(): Promise<Map<string, ClaudeSession[]>> {
    const allSessions = await this.getAllSessionsFlat();
    const grouped = new Map<string, ClaudeSession[]>();

    for (const session of allSessions) {
      const cwd = session.cwd;
      if (!grouped.has(cwd)) {
        grouped.set(cwd, []);
      }
      grouped.get(cwd)!.push(session);
    }

    return grouped;
  }

  /**
   * Get session info by session ID
   */
  async getSessionById(sessionId: string): Promise<ClaudeSession | null> {
    const projectDirs = this.getProjectDirs();

    for (const dir of projectDirs) {
      const filePath = path.join(dir, `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) {
        return this.parseSessionFile(filePath, sessionId);
      }
    }

    return null;
  }

  /**
   * Quick check if a session is resumable (has actual conversation content)
   * This is faster than full parsing - just checks for user/assistant messages
   */
  isSessionResumable(sessionId: string): boolean {
    const filePath = this.findSessionFilePath(sessionId);
    if (!filePath) {
      return false;
    }

    // A resumable session has user/assistant messages, which appear at the very start
    // of the log. Read only a bounded prefix (not the whole, possibly multi-MB, file) so
    // this stays cheap and never blocks — it's called synchronously before opening a terminal.
    const maxBytes = 512 * 1024;
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
        const text = buf.subarray(0, bytesRead).toString('utf-8');
        const lines = text.split('\n');
        // Drop a trailing partial line if we filled the buffer (the file continues past it).
        const complete = bytesRead >= maxBytes ? lines.slice(0, -1) : lines;

        for (const line of complete) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' || entry.type === 'assistant') {
              return true;
            }
          } catch {
            // Skip invalid/partial JSON
          }
        }

        // No conversation found in the prefix. If the file is larger than what we read,
        // assume it's resumable rather than risk hiding a real session.
        return bytesRead >= maxBytes;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  /**
   * Encode a worktree path to Claude's project directory format.
   * Claude Code replaces every non-alphanumeric character with a dash — including
   * the Windows drive colon and spaces, not just separators and dots. Getting this
   * exactly right is required for forking (the destination folder must be the name
   * Claude will later compute for that worktree) and for session auto-linking.
   */
  encodeProjectPath(worktreePath: string): string {
    const normalizedPath = path.resolve(worktreePath);
    return normalizedPath.replace(/[^a-zA-Z0-9]/g, '-');
  }

  /**
   * Find the project directory that actually contains a given session file.
   * More robust than encoding a path, since forked/copied sessions can live in a
   * directory whose name was derived from a different cwd.
   */
  private findProjectDirForSession(sessionId: string): string | null {
    const fp = this.findSessionFilePath(sessionId);
    return fp ? path.dirname(fp) : null;
  }

  /**
   * Get the Claude project directory for a worktree path
   */
  getProjectDir(worktreePath: string): string {
    const encoded = this.encodeProjectPath(worktreePath);
    return path.join(this.projectsDir, encoded);
  }

  /**
   * Copy all session data from one worktree's project folder to another
   * This enables forking sessions across worktrees
   * (Based on CCManager's copyClaudeSessionData implementation)
   */
  copySessionToWorktree(sessionId: string, sourceWorktreePath: string, destWorktreePath: string): boolean {
    try {
      // Prefer the directory that actually holds the session file; fall back to the
      // encoded source path only if the file can't be located that way.
      const sourceProjectDir = this.findProjectDirForSession(sessionId)
        ?? this.getProjectDir(sourceWorktreePath);
      const destProjectDir = this.getProjectDir(destWorktreePath);

      if (!fs.existsSync(sourceProjectDir)) {
        console.error(`Source project directory not found: ${sourceProjectDir}`);
        return false;
      }

      // Copy the entire project directory recursively
      // This preserves all session files and context
      fs.cpSync(sourceProjectDir, destProjectDir, {
        recursive: true,
        force: true,
        preserveTimestamps: true,
      });

      return true;
    } catch (error) {
      console.error('Failed to copy session data:', error);
      return false;
    }
  }

  /**
   * Get the last few user messages from a session (for preview).
   * Streamed with a rolling buffer so only the last N messages are ever held in memory.
   */
  async getSessionPreview(sessionId: string, maxMessages: number = 3, knownFilePath?: string): Promise<string[]> {
    const filePath = knownFilePath ?? this.findSessionFilePath(sessionId);
    if (!filePath) {
      return [];
    }

    const recent: string[] = [];
    try {
      await this.streamLines(filePath, (line) => {
        if (!line.trim()) return;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line);
        } catch {
          return; // Skip invalid lines
        }
        const text = promptText(entry);
        if (text) {
          const truncated = text.length > 100 ? text.substring(0, 100) + '...' : text;
          recent.push(truncated.replace(/\n/g, ' '));
          if (recent.length > maxMessages) {
            recent.shift();
          }
        }
      });
    } catch {
      return [];
    }

    return recent;
  }

  /**
   * Get the most recent recap for a session (from away_summary entries).
   */
  async getSessionRecap(sessionId: string): Promise<string | null> {
    const filePath = this.findSessionFilePath(sessionId);
    if (!filePath) {
      return null;
    }

    let latestRecap: string | null = null;
    let latestTs = 0;
    try {
      await this.streamLines(filePath, (line) => {
        if (!line.trim()) return;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line);
        } catch {
          return;
        }
        if (entry.type === 'system' && entry.subtype === 'away_summary' && entry.content) {
          const ts = entry.timestamp ? new Date(entry.timestamp as string).getTime() : 0;
          if (ts >= latestTs) {
            latestTs = ts;
            latestRecap = (entry.content as string).replace(/\s*\(disable recaps in \/config\)\s*$/, '').trim();
          }
        }
      });
    } catch {
      return null;
    }

    return latestRecap;
  }
}
