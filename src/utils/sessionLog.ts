/**
 * Reading names and prompts out of Claude Code session logs (`~/.claude/projects/<dir>/<id>.jsonl`,
 * one JSON entry per line).
 */
import * as os from 'os';
import * as path from 'path';

export type LogEntry = Record<string, unknown>;

/** Claude Code's config folder, which holds `projects/`: `CLAUDE_CONFIG_DIR` if set, else `~/.claude`. */
export function claudeConfigDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configured) {
    return path.resolve(configured.replace(/^~(?=$|[\\/])/, home));
  }
  return path.join(home, '.claude');
}

/**
 * Text Claude Code adds to a user message, wrapped in tags such as `<system-reminder>`,
 * `<local-command-stdout>` or `<command-message>`. None of it is what the user typed.
 */
const ADDED_BLOCK = /<([a-z]+(?:[-_][a-z]+)+)>[\s\S]*?<\/\1>/g;

/** The text of a message: a plain string, or its text blocks (tool results are skipped). */
function messageText(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  if (!message || typeof message !== 'object') {
    return '';
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

/**
 * What the user typed in a log entry, or null if the entry isn't a typed prompt (an
 * assistant message, a tool result, or text Claude Code added itself). A slash command
 * comes back as `/name args`.
 */
export function promptText(entry: LogEntry): string | null {
  if (entry.type !== 'user' || entry.isMeta || !entry.message) {
    return null;
  }
  const text = messageText(entry.message);
  if (!text) {
    return null;
  }
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1].trim();
    return [command[1].trim(), args].filter(Boolean).join(' ') || null;
  }
  return text.replace(ADDED_BLOCK, ' ').trim() || null;
}

/**
 * A title recorded in the log: `custom-title` (written by current Claude Code versions,
 * including `/rename`), or `summary` (older versions). Later entries replace earlier ones.
 */
export function titleFrom(entry: LogEntry): string | null {
  const title =
    entry.type === 'custom-title' ? entry.customTitle : entry.type === 'summary' ? entry.summary : undefined;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

/** Collapse whitespace and cut to about `maxLength` characters at a word boundary. */
export function shortName(text: string, maxLength = 50): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const truncated = cleaned.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLength * 0.6 ? truncated.substring(0, lastSpace) : truncated) + '...';
}

/** Tracks a session's name while its log is read line by line. */
export class SessionNamer {
  private title: string | null = null;
  private firstPrompt: string | null = null;

  /** Feed one parsed log entry. */
  add(entry: LogEntry): void {
    const title = titleFrom(entry);
    if (title) {
      this.title = title;
    } else if (this.firstPrompt === null) {
      this.firstPrompt = promptText(entry);
    }
  }

  /** Whether a recorded title was seen (rather than only a first prompt). */
  get hasTitle(): boolean {
    return this.title !== null;
  }

  /** The recorded title, else the first prompt shortened, else null. */
  get name(): string | null {
    if (this.title) {
      return shortName(this.title, 80);
    }
    return this.firstPrompt ? shortName(this.firstPrompt) : null;
  }
}
