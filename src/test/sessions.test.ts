import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeSessionService } from '../services/ClaudeSessionService';
import { ChatStore, SessionWatcher } from '../services/SessionWatcher';
import { ChatSession } from '../types';
import { makeTempDir, removeDir } from './helpers';

// ClaudeSessionService reads HOME (or USERPROFILE) when constructed, so point both at a
// fake home with its own ~/.claude/projects for the duration of these tests.
const savedEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};
let tmp: string;
let home: string;

before(() => {
  tmp = makeTempDir('agntree-sessions-');
  home = path.join(tmp, 'home');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
});

after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  removeDir(tmp);
});

/** Claude Code's project folder name for a cwd: every non-alphanumeric character becomes "-". */
const encode = (cwd: string) => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');

/** Write a session log in the shape current Claude Code versions produce. */
function writeSession(
  cwd: string,
  id: string,
  options: { title?: string; prompt?: string; branch?: string; configDir?: string } = {}
): string {
  const dir = path.join(options.configDir ?? path.join(home, '.claude'), 'projects', encode(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    {
      type: 'user',
      cwd,
      gitBranch: options.branch ?? 'main',
      sessionId: id,
      message: { role: 'user', content: options.prompt ?? 'hello there' },
      timestamp: new Date().toISOString(),
    },
    ...(options.title ? [{ type: 'custom-title', customTitle: options.title, sessionId: id }] : []),
    {
      type: 'assistant',
      cwd,
      gitBranch: options.branch ?? 'main',
      sessionId: id,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    },
  ];
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

const uuid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

describe('ClaudeSessionService', () => {
  it('encodes paths the way Claude Code names its project folders', () => {
    const service = new ClaudeSessionService();
    if (process.platform === 'win32') {
      // A real folder name from ~/.claude/projects on Windows
      assert.equal(
        service.encodeProjectPath('C:\\Source\\DevOps\\aws-terraform\\.claude\\worktrees\\eager-feynman-8ff4f6'),
        'C--Source-DevOps-aws-terraform--claude-worktrees-eager-feynman-8ff4f6'
      );
    } else {
      assert.equal(
        service.encodeProjectPath('/home/coder/repo/.claude/worktrees/eager-feynman-8ff4f6'),
        '-home-coder-repo--claude-worktrees-eager-feynman-8ff4f6'
      );
    }
  });

  it("finds a worktree's sessions by their recorded cwd, with branch and first prompt", async () => {
    const repo = path.join(tmp, 'basic-repo');
    writeSession(repo, uuid('1'), { prompt: 'Fix the login redirect loop', branch: 'feature/login' });

    const sessions = await new ClaudeSessionService().findSessionsForWorktree(repo);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, uuid('1'));
    assert.equal(sessions[0].gitBranch, 'feature/login');
    assert.equal(sessions[0].summary, 'Fix the login redirect loop');
    assert.equal(sessions[0].messageCount, 2);
  });

  it('ignores agent-*.jsonl side logs', async () => {
    const repo = path.join(tmp, 'agent-logs-repo');
    const file = writeSession(repo, uuid('2'));
    fs.copyFileSync(file, path.join(path.dirname(file), 'agent-1234.jsonl'));

    const sessions = await new ClaudeSessionService().findSessionsForWorktree(repo);
    assert.deepEqual(sessions.map((s) => s.sessionId), [uuid('2')]);
  });

  it('names sessions from custom-title entries', async () => {
    const repo = path.join(tmp, 'title-repo');
    writeSession(repo, uuid('3'), { title: 'Fix login redirect loop', prompt: 'the first thing I typed' });
    const [session] = await new ClaudeSessionService().findSessionsForWorktree(repo);
    assert.equal(session.summary, 'Fix login redirect loop');
  });

  it('names an untitled session after the prompt, not the system text before it', async () => {
    const repo = path.join(tmp, 'reminder-repo');
    writeSession(repo, uuid('a'), {
      prompt: '<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>\n\nAdd retries to the upload client',
    });
    const [session] = await new ClaudeSessionService().findSessionsForWorktree(repo);
    assert.equal(session.summary, 'Add retries to the upload client');
  });

  it('matches sessions started in a subfolder of the worktree', async () => {
    const repo = path.join(tmp, 'subfolder-repo');
    writeSession(path.join(repo, 'packages', 'api'), uuid('6'));
    const ids = (await new ClaudeSessionService().findSessionsForWorktree(repo)).map((s) => s.sessionId);
    assert.deepEqual(ids, [uuid('6')]);
  });

  it("reads only the project folders named after the repository's paths", async () => {
    const repo = path.join(tmp, 'scoped-repo');
    const worktree = path.join(tmp, 'scoped-repo-worktrees', 'feature');
    writeSession(repo, uuid('b'));
    writeSession(worktree, uuid('c'));
    // A log whose cwd is in the repo but which sits in some other project's folder. Claude
    // Code never stores it there, so finding it would mean every folder was read.
    const elsewhere = path.join(home, '.claude', 'projects', 'some-other-project');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.copyFileSync(path.join(home, '.claude', 'projects', encode(repo), `${uuid('b')}.jsonl`), path.join(elsewhere, `${uuid('d')}.jsonl`));

    const found = await new ClaudeSessionService().findSessionsForRepository(repo, [repo, worktree]);
    assert.deepEqual(found.map((s) => s.sessionId).sort(), [uuid('b'), uuid('c')]);
  });

  it('previews what the user typed, skipping system text and tool results', async () => {
    const repo = path.join(tmp, 'preview-repo');
    const file = writeSession(repo, uuid('e'), { prompt: '<system-reminder>info</system-reminder>\n\nfirst request' });
    fs.appendFileSync(
      file,
      [
        { type: 'user', cwd: repo, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'output' }] } },
        { type: 'user', cwd: repo, isMeta: true, message: { role: 'user', content: 'Caveat: generated by local commands' } },
        { type: 'user', cwd: repo, message: { role: 'user', content: 'second request' } },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n'
    );
    const service = new ClaudeSessionService();
    assert.deepEqual(await service.getSessionPreview(uuid('e'), 5), ['first request', 'second request']);
    assert.deepEqual(await service.getSessionPreview(uuid('e'), 1, file), ['second request']);
  });

  it('reads sessions from CLAUDE_CONFIG_DIR when it is set', async () => {
    const configDir = path.join(tmp, 'custom-config');
    const repo = path.join(tmp, 'config-dir-repo');
    writeSession(repo, uuid('9'), { configDir });
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      const sessions = await new ClaudeSessionService().findSessionsForWorktree(repo);
      assert.deepEqual(sessions.map((s) => s.sessionId), [uuid('9')]);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });
});

/** Distinct session IDs for the tests below, which need more than `uuid` gives. */
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('copySessionToWorktree', () => {
  it('copies only the forked session when forking to a new worktree', async () => {
    const repo = path.join(tmp, 'fork-repo');
    const fork = path.join(tmp, 'fork-repo-worktrees', 'fork');
    writeSession(repo, uuid('7'));
    writeSession(repo, uuid('8'), { prompt: 'an unrelated session' });

    const service = new ClaudeSessionService();
    assert.equal(await service.copySessionToWorktree(uuid('7'), repo, fork), true);
    assert.deepEqual(fs.readdirSync(service.getProjectDir(fork)), [`${uuid('7')}.jsonl`]);
    const found = await service.findSessionsForRepository(repo, [repo, fork]);
    assert.equal(new Set(found.map((s) => s.filePath)).size, found.length);
    assert.equal(found.filter((s) => s.sessionId === uuid('8')).length, 1);
  });

  it("copies the session's own folder, and leaves an existing copy alone", async () => {
    const repo = path.join(tmp, 'fork-folder-repo');
    const fork = path.join(tmp, 'fork-folder-repo-worktrees', 'fork');
    const log = writeSession(repo, sid(1));
    const titleFile = path.join(path.dirname(log), sid(1), 'custom-title.json');
    fs.mkdirSync(path.dirname(titleFile), { recursive: true });
    fs.writeFileSync(titleFile, JSON.stringify({ customTitle: 'Fix login' }));

    const service = new ClaudeSessionService();
    const copiedLog = path.join(service.getProjectDir(fork), `${sid(1)}.jsonl`);
    fs.mkdirSync(path.dirname(copiedLog), { recursive: true });
    fs.writeFileSync(copiedLog, 'already here\n');

    assert.equal(await service.copySessionToWorktree(sid(1), repo, fork), true);
    assert.equal(fs.readFileSync(copiedLog, 'utf-8'), 'already here\n');
    assert.ok(fs.existsSync(path.join(service.getProjectDir(fork), sid(1), 'custom-title.json')));
  });

  it("reports failure when the session's log doesn't exist", async () => {
    const service = new ClaudeSessionService();
    assert.equal(await service.copySessionToWorktree(sid(2), path.join(tmp, 'no-repo'), path.join(tmp, 'no-fork')), false);
  });
});

/** In-memory chats, standing in for StorageService. */
class FakeChats implements ChatStore {
  private chats = new Map<string, ChatSession>();

  add(id: string, extra: Partial<ChatSession> = {}): void {
    this.chats.set(id, {
      id,
      worktreeId: 'wt',
      name: 'New Session',
      claudeSessionId: null,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      status: 'active',
      baseCommit: null,
      ...extra,
    });
  }

  getChat(id: string): ChatSession | undefined {
    const chat = this.chats.get(id);
    return chat ? { ...chat } : undefined;
  }

  getChats(): ChatSession[] {
    return [...this.chats.values()].map((chat) => ({ ...chat }));
  }

  updateChat(id: string, updates: Partial<ChatSession>): ChatSession | undefined {
    const chat = this.chats.get(id);
    if (!chat) {
      return undefined;
    }
    const updated = { ...chat, ...updates };
    this.chats.set(id, updated);
    return { ...updated };
  }

  renameChat(id: string, name: string): ChatSession | undefined {
    return this.updateChat(id, { name });
  }
}

describe('SessionWatcher', () => {
  it('links a chat only to the session it started, not to other new logs in its worktree', () => {
    const worktree = path.join(tmp, 'watcher-repo');
    const chats = new FakeChats();
    const watcher = new SessionWatcher(chats, new ClaudeSessionService());
    try {
      // Chat A has sent its first prompt; chat B was opened just after, in the same worktree.
      chats.add('chat-a', { pendingSessionId: sid(10) });
      chats.add('chat-b', { pendingSessionId: sid(11) });
      writeSession(worktree, sid(10));
      // A session something else started there (a Quick Action, another terminal)
      writeSession(worktree, sid(12));

      assert.equal(watcher.linkIfStarted('chat-b', worktree), undefined);
      assert.equal(chats.getChat('chat-b')?.claudeSessionId, null);
      assert.equal(watcher.linkIfStarted('chat-a', worktree)?.claudeSessionId, sid(10));

      writeSession(worktree, sid(11));
      const linked = watcher.linkIfStarted('chat-b', worktree);
      assert.equal(linked?.claudeSessionId, sid(11));
      assert.equal(linked?.pendingSessionId, undefined);
    } finally {
      watcher.dispose();
    }
  });

  it('links a fork to its own new session, and forgets where it was forked from', () => {
    const worktree = path.join(tmp, 'watcher-fork-repo');
    const chats = new FakeChats();
    const watcher = new SessionWatcher(chats, new ClaudeSessionService());
    try {
      writeSession(worktree, sid(20));
      chats.add('fork', { name: 'Fork of X (abcd)', pendingSessionId: sid(21), forkFromSessionId: sid(20) });
      assert.equal(watcher.linkIfStarted('fork', worktree), undefined);

      writeSession(worktree, sid(21));
      const linked = watcher.linkIfStarted('fork', worktree);
      assert.equal(linked?.claudeSessionId, sid(21));
      assert.equal(linked?.forkFromSessionId, undefined);
    } finally {
      watcher.dispose();
    }
  });

  it('only links a log with a conversation when asked to', () => {
    const worktree = path.join(tmp, 'watcher-empty-repo');
    const chats = new FakeChats();
    const watcher = new SessionWatcher(chats, new ClaudeSessionService());
    try {
      chats.add('chat', { pendingSessionId: sid(30) });
      const dir = path.join(home, '.claude', 'projects', encode(worktree));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sid(30)}.jsonl`), JSON.stringify({ type: 'queue-operation', sessionId: sid(30) }) + '\n');

      assert.equal(watcher.linkIfStarted('chat', worktree, { requireConversation: true }), undefined);
      assert.equal(watcher.linkIfStarted('chat', worktree)?.claudeSessionId, sid(30));
    } finally {
      watcher.dispose();
    }
  });

  it('finds a log by session ID in the folder for its working directory', () => {
    const worktree = path.join(tmp, 'find-log-repo');
    const file = writeSession(worktree, sid(40));
    const service = new ClaudeSessionService();
    assert.equal(service.findSessionLog(sid(40), worktree), file);
    assert.equal(service.findSessionLog(sid(41), worktree), null);
    assert.equal(service.findSessionLog(sid(40), path.join(tmp, 'other-repo')), null);
  });
});

// Known bugs from the review that are not fixed yet. `todo` tests run and report, but
// don't fail the suite; they pass once the bug is fixed.
describe('ClaudeSessionService known bugs (todo)', () => {
  it("doesn't offer a nested .claude/worktrees session for the main worktree", { todo: 'any cwd under the main worktree matches, including Claude worktrees inside it' }, async () => {
    const repo = path.join(tmp, 'nested-repo');
    writeSession(repo, uuid('4'));
    writeSession(path.join(repo, '.claude', 'worktrees', 'eager-feynman-8ff4f6'), uuid('5'), { branch: 'claude/eager-feynman-8ff4f6' });
    const ids = (await new ClaudeSessionService().findSessionsForWorktree(repo)).map((s) => s.sessionId);
    assert.deepEqual(ids, [uuid('4')]);
  });
});
