import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeSessionService } from '../services/ClaudeSessionService';
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
});

// Known bugs from the review that are not fixed yet. `todo` tests run and report, but
// don't fail the suite; they pass once the bug is fixed.
describe('ClaudeSessionService known bugs (todo)', () => {
  it('names sessions from custom-title entries', { todo: 'current Claude Code writes custom-title, not summary; names fall back to the first prompt' }, async () => {
    const repo = path.join(tmp, 'title-repo');
    writeSession(repo, uuid('3'), { title: 'Fix login redirect loop', prompt: 'the first thing I typed' });
    const [session] = await new ClaudeSessionService().findSessionsForWorktree(repo);
    assert.equal(session.summary, 'Fix login redirect loop');
  });

  it("doesn't offer a nested .claude/worktrees session for the main worktree", { todo: 'on Linux, any cwd under the main worktree matches, including Claude worktrees inside it' }, async () => {
    const repo = path.join(tmp, 'nested-repo');
    writeSession(repo, uuid('4'));
    writeSession(path.join(repo, '.claude', 'worktrees', 'eager-feynman-8ff4f6'), uuid('5'), { branch: 'claude/eager-feynman-8ff4f6' });
    const ids = (await new ClaudeSessionService().findSessionsForWorktree(repo)).map((s) => s.sessionId);
    assert.deepEqual(ids, [uuid('4')]);
  });

  it('matches sessions started in a subfolder of the worktree', { todo: 'on Windows the subfolder check compares against "/" and never matches' }, async () => {
    const repo = path.join(tmp, 'subfolder-repo');
    writeSession(path.join(repo, 'packages', 'api'), uuid('6'));
    const ids = (await new ClaudeSessionService().findSessionsForWorktree(repo)).map((s) => s.sessionId);
    assert.deepEqual(ids, [uuid('6')]);
  });

  it('copies only the forked session when forking to a new worktree', { todo: 'copySessionToWorktree copies the whole project folder, so Search then lists every session twice' }, async () => {
    const repo = path.join(tmp, 'fork-repo');
    const fork = path.join(tmp, 'fork-repo-worktrees', 'fork');
    writeSession(repo, uuid('7'));
    writeSession(repo, uuid('8'), { prompt: 'an unrelated session' });

    const service = new ClaudeSessionService();
    assert.equal(service.copySessionToWorktree(uuid('7'), repo, fork), true);
    assert.deepEqual(fs.readdirSync(service.getProjectDir(fork)), [`${uuid('7')}.jsonl`]);
    const found = await service.findSessionsForRepository(repo, [repo, fork]);
    assert.equal(new Set(found.map((s) => s.filePath)).size, found.length);
    assert.equal(found.filter((s) => s.sessionId === uuid('8')).length, 1);
  });

  it('reads sessions from CLAUDE_CONFIG_DIR when it is set', { todo: 'the service always reads ~/.claude' }, async () => {
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
