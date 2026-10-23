/**
 * Represents a git repository added to the workspace manager
 */
export interface Repository {
  /** Unique identifier */
  id: string;
  /** Display name (usually folder name) */
  name: string;
  /** Absolute path to the repository root (where .git is) */
  rootPath: string;
  /** Whether the repository is hidden (soft removed) */
  hidden?: boolean;
}

/**
 * Represents a git worktree within a repository
 */
export interface Worktree {
  /** Unique identifier */
  id: string;
  /** Parent repository ID */
  repoId: string;
  /** Display name: the branch, or the folder name when HEAD is detached */
  name: string;
  /**
   * Local branch checked out in this worktree, or null when HEAD is detached.
   * Use this (never `name`) for anything that operates on the branch.
   */
  branch: string | null;
  /** Commit SHA checked out, if known */
  head: string | null;
  /** Absolute path to the worktree directory */
  path: string;
  /** Whether this is the main worktree */
  isMain: boolean;
  /** Whether HEAD is detached (no branch checked out) */
  isDetached: boolean;
}

/**
 * Represents a Claude Code chat session
 */
export interface ChatSession {
  /** Unique identifier */
  id: string;
  /** Parent worktree ID */
  worktreeId: string;
  /** User-defined name for the chat */
  name: string;
  /** Claude Code session ID for --resume flag, set once its log exists */
  claudeSessionId: string | null;
  /**
   * The ID Agntree gave Claude Code (`--session-id`) for a session that hasn't written
   * its log yet. It becomes `claudeSessionId` when the log `<id>.jsonl` appears, so a
   * chat is only ever linked to the session it started.
   */
  pendingSessionId?: string;
  /** For a fork that hasn't started yet: the session it copies its history from */
  forkFromSessionId?: string;
  /** Unix timestamp of creation */
  createdAt: number;
  /** Unix timestamp of last access */
  lastAccessedAt: number;
  /** Current status of the chat */
  status: 'active' | 'idle' | 'closed';
  /** Git commit SHA when session started (for tracking changes) */
  baseCommit: string | null;
}

/**
 * Represents a file change tracked during a chat session
 */
export interface FileChange {
  /** Relative file path from worktree root */
  path: string;
  /** Previous path, for renames and copies */
  origPath?: string;
  /** Type of change */
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  /** Number of lines added */
  additions: number;
  /** Number of lines removed */
  deletions: number;
}

/**
 * Staged and unstaged changes in a worktree, as reported by git status.
 */
export interface WorkingTreeStatus {
  staged: FileChange[];
  /** Unstaged changes, untracked files, and unresolved merge conflicts */
  unstaged: FileChange[];
}

/**
 * Represents GitHub PR info for a branch
 */
export interface PRInfo {
  /** PR number */
  number: number;
  /** PR title */
  title: string;
  /** PR state */
  state: 'open' | 'merged' | 'closed';
  /** Whether the PR is a draft */
  isDraft: boolean;
  /** PR URL */
  url: string;
  /** PR source branch name */
  headRefName?: string;
}

/**
 * Tree item types for context menu identification
 */
export type TreeItemType = 'repository' | 'worktree' | 'chat' | 'changedFile';

/**
 * Storage keys used in VS Code globalState
 */
export const STORAGE_KEYS = {
  REPOSITORIES: 'agntree.repositories',
  CHATS: 'agntree.chats',
  ACTIVE_CHAT: 'agntree.activeChat',
  ACTIVE_WORKTREE_ID: 'agntree.activeWorktreeId',
  PR_WORKTREES: 'agntree.prWorktrees',
  STARRED_CHATS: 'agntree.starredChats',
} as const;

/**
 * Generates a UUID v4
 */
export function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
