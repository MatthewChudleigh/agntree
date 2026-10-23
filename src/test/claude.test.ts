import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { claudeCommand, isSessionId } from '../utils/claudeCommand';
import { LiveSessionService, parseLiveSessions } from '../services/LiveSessionService';
import { makeTempDir, removeDir } from './helpers';

const ID = '78656170-f415-4a09-bc65-2d28e1d0cf54';
const OTHER = 'd0df6849-fdf1-49a6-885b-413d20e2ecc4';

describe('claudeCommand', () => {
  it('resumes a session', () => {
    assert.equal(claudeCommand({ resume: ID }), `claude --resume ${ID}`);
  });

  it('starts a new session with the ID chosen for it', () => {
    assert.equal(claudeCommand({ newSessionId: ID }), `claude --session-id ${ID}`);
  });

  it('forks into a session with the ID chosen for it', () => {
    assert.equal(
      claudeCommand({ forkFrom: OTHER, newSessionId: ID }),
      `claude --resume ${OTHER} --fork-session --session-id ${ID}`
    );
  });

  it('refuses IDs that are not session IDs, since the command is typed into a shell', () => {
    for (const bad of ['', 'abc', `${ID}; rm -rf ~`, '$(whoami)', `${ID} --dangerously-skip-permissions`]) {
      assert.equal(isSessionId(bad), false, bad);
      assert.equal(claudeCommand({ resume: bad }), null, bad);
      assert.equal(claudeCommand({ newSessionId: bad }), null, bad);
      assert.equal(claudeCommand({ forkFrom: bad, newSessionId: ID }), null, bad);
    }
  });
});

describe('parseLiveSessions', () => {
  it('reads `claude agents --json` output', () => {
    // As Claude Code 2.1.302 prints it
    const output = [
      {
        pid: 27412,
        cwd: '/home/coder/agntree/.claude/worktrees/project-analysis-review-97ee2d',
        kind: 'interactive',
        startedAt: 1792728345030,
        sessionId: ID,
        name: 'VS Code plugin code review',
        status: 'busy',
      },
      { pid: 1, cwd: '/x' }, // no session ID: skipped
      'nonsense',
    ];
    assert.deepEqual(parseLiveSessions(output), [
      {
        pid: 27412,
        sessionId: ID,
        cwd: '/home/coder/agntree/.claude/worktrees/project-analysis-review-97ee2d',
        name: 'VS Code plugin code review',
        status: 'busy',
      },
    ]);
  });
});

describe('LiveSessionService', () => {
  let configDir: string;

  before(() => {
    configDir = makeTempDir('agntree-live-');
  });

  after(() => {
    removeDir(configDir);
  });

  it("reads Claude Code's session registry when the claude command can't run", async () => {
    const sessionsDir = path.join(configDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const worktree = path.join(configDir, 'repo', '.claude', 'worktrees', 'eager-feynman');
    const entry = (pid: number, sessionId: string) =>
      JSON.stringify({ pid, sessionId, cwd: worktree, name: 'Fix login', status: 'idle', entrypoint: 'claude-desktop' });
    fs.writeFileSync(path.join(sessionsDir, '1001.json'), entry(1001, ID));
    // A process that has exited
    fs.writeFileSync(path.join(sessionsDir, '1002.json'), entry(1002, OTHER));
    // Key files hold secrets and must never be read, even if they parse
    fs.writeFileSync(path.join(sessionsDir, '1001.0123abcd.key'), entry(1001, '11111111-1111-4111-8111-111111111111'));
    fs.writeFileSync(path.join(sessionsDir, '1003.json'), '{ half-written');

    const service = new LiveSessionService({
      configDir,
      command: path.join(configDir, 'no-such-claude'),
      isAlive: (pid) => pid === 1001,
    });
    assert.deepEqual(await service.list(), [{ pid: 1001, sessionId: ID, cwd: worktree, name: 'Fix login', status: 'idle' }]);
    assert.equal((await service.find(ID))?.pid, 1001);
    assert.equal(await service.find(OTHER), undefined);
    assert.equal((await service.within(path.join(configDir, 'repo'))).length, 1);
    assert.deepEqual(await service.within(path.join(configDir, 'elsewhere')), []);
  });

  it('reports no sessions when Claude Code has no registry', async () => {
    const service = new LiveSessionService({ configDir: path.join(configDir, 'empty'), command: path.join(configDir, 'no-such-claude') });
    assert.deepEqual(await service.list(), []);
  });
});
