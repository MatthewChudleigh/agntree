import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { GitError, GitRunOptions, GitService, describeGitError } from '../services/GitService';
import { samePath } from '../utils/paths';
import { commitFile, git, initRepo, makeTempDir, removeDir, slowCommand, writeFile } from './helpers';

/** GitService that records the git commands it runs and exposes run() to tests. */
class InstrumentedGit extends GitService {
  commands: string[][] = [];

  protected override run(args: string[], opts?: GitRunOptions): Promise<string> {
    this.commands.push(args);
    return super.run(args, opts);
  }

  runForTest(args: string[], opts?: GitRunOptions): Promise<string> {
    return this.run(args, opts);
  }
}

const gitService = new GitService();
let tmp: string;

before(() => {
  tmp = makeTempDir();
});

after(() => {
  removeDir(tmp);
});

/** A fresh directory for one test. */
function scratch(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function branchExists(repo: string, branch: string): boolean {
  return git(repo, 'branch', '--list', branch).trim().length > 0;
}

describe('listWorktrees', () => {
  it('reports the branch, or null for a detached worktree named after its folder', async () => {
    const dir = scratch('list-detached');
    const repo = initRepo(path.join(dir, 'repo'));
    git(repo, 'branch', 'feature-x'); // unrelated branch that shares the detached worktree's folder name
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/login', path.join(dir, 'wt', 'feature-login'));
    git(repo, 'worktree', 'add', '-q', '--detach', path.join(dir, 'wt', 'feature-x'));

    const worktrees = await gitService.listWorktrees(repo, 'repo-1');
    assert.equal(worktrees.length, 3);

    const [main, feature, detached] = worktrees;
    assert.equal(main.isMain, true);
    assert.equal(main.branch, 'main');
    assert.equal(feature.branch, 'feature/login');
    assert.equal(feature.isDetached, false);
    assert.equal(detached.name, 'feature-x');
    assert.equal(detached.branch, null, 'a detached worktree must not report its folder name as a branch');
    assert.equal(detached.isDetached, true);
  });

  it('skips the bare repository entry', async () => {
    const dir = scratch('list-bare');
    const source = initRepo(path.join(dir, 'source'));
    const bare = path.join(dir, 'bare.git');
    git(dir, 'clone', '-q', '--bare', source, bare);
    git(bare, 'worktree', 'add', '-q', path.join(dir, 'bare-wt'), 'main');

    const worktrees = await gitService.listWorktrees(bare, 'repo-1');
    assert.equal(worktrees.length, 1);
    assert.ok(!worktrees.some((w) => samePath(w.path, bare)), 'the bare repo itself is not a worktree');
    assert.equal(worktrees[0].branch, 'main');
  });

  it('marks the real main worktree when listed from a linked worktree', async () => {
    const dir = scratch('list-from-linked');
    const repo = initRepo(path.join(dir, 'repo'));
    const nested = path.join(repo, '.claude', 'worktrees', 'eager-feynman-8ff4f6');
    git(repo, 'worktree', 'add', '-q', '-b', 'claude/eager-feynman-8ff4f6', nested);

    const worktrees = await gitService.listWorktrees(nested, 'repo-1');
    const main = worktrees.filter((w) => w.isMain);
    assert.equal(main.length, 1);
    assert.ok(samePath(main[0].path, repo));
  });

  it('gives the same worktree the same ID on every call', async () => {
    const repo = initRepo(path.join(scratch('list-ids'), 'repo'));
    const [first] = await gitService.listWorktrees(repo, 'repo-1');
    const [second] = await gitService.listWorktrees(repo, 'repo-1');
    assert.match(first.id, /^wt-[0-9a-f]{8}$/);
    assert.equal(first.id, second.id);
  });
});

describe('deleteBranch', () => {
  it('refuses to delete a branch with unmerged commits unless forced', async () => {
    const repo = initRepo(path.join(scratch('delete-unmerged'), 'repo'));
    git(repo, 'checkout', '-q', '-b', 'claude/work');
    commitFile(repo, 'work.txt', 'unpushed work\n');
    git(repo, 'checkout', '-q', 'main');

    const refused = await gitService.deleteBranch(repo, 'claude/work');
    assert.deepEqual(refused, { deleted: false, notMerged: true, unmergedCommits: 1, mergeTarget: 'main' });
    assert.ok(branchExists(repo, 'claude/work'), 'the branch must survive a non-forced delete');

    const forced = await gitService.deleteBranch(repo, 'claude/work', { force: true });
    assert.deepEqual(forced, { deleted: true });
    assert.ok(!branchExists(repo, 'claude/work'));
  });

  it('deletes a merged branch without forcing', async () => {
    const repo = initRepo(path.join(scratch('delete-merged'), 'repo'));
    git(repo, 'branch', 'merged-already');
    assert.deepEqual(await gitService.deleteBranch(repo, 'merged-already'), { deleted: true });
  });

  it('reports a branch that does not exist instead of calling it unmerged', async () => {
    const repo = initRepo(path.join(scratch('delete-missing'), 'repo'));
    const result = await gitService.deleteBranch(repo, 'no-such-branch');
    assert.equal(result.deleted, false);
    assert.ok('error' in result && /does not exist/.test(result.error));
  });
});

describe('getStatus', () => {
  it('reports a staged rename once, with its original path, and can unstage it', async () => {
    const repo = initRepo(path.join(scratch('status-rename'), 'repo'), {
      'src/alpha.ts': Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n',
    });
    git(repo, 'mv', 'src/alpha.ts', 'src/beta.ts');

    const status = await gitService.getStatus(repo);
    assert.equal(status.staged.length, 1);
    assert.deepEqual(status.staged[0], {
      path: 'src/beta.ts',
      origPath: 'src/alpha.ts',
      status: 'renamed',
      additions: 0,
      deletions: 0,
    });

    const result = await gitService.unstageFiles(repo, ['src/beta.ts', 'src/alpha.ts']);
    assert.equal(result.ok, true);
    assert.equal((await gitService.getStatus(repo)).staged.length, 0);
  });

  it('returns non-ASCII file names as written, and can stage them', async () => {
    const repo = initRepo(path.join(scratch('status-unicode'), 'repo'), { 'café.txt': 'a\n' });
    writeFile(repo, 'café.txt', 'b\n');
    writeFile(repo, 'naïve-new.txt', 'new\n');

    const status = await gitService.getStatus(repo);
    const modified = status.unstaged.find((c) => c.path === 'café.txt');
    const untracked = status.unstaged.find((c) => c.path === 'naïve-new.txt');
    assert.equal(modified?.status, 'modified');
    assert.equal(modified?.additions, 1);
    assert.equal(modified?.deletions, 1);
    assert.equal(untracked?.status, 'untracked');

    assert.equal((await gitService.stageFiles(repo, ['café.txt'])).ok, true);
    assert.ok((await gitService.getStatus(repo)).staged.some((c) => c.path === 'café.txt'));
  });

  it('lists staged additions, deletions and unresolved conflicts', async () => {
    const repo = initRepo(path.join(scratch('status-kinds'), 'repo'), { 'keep.txt': 'k\n', 'gone.txt': 'g\n', 'f.txt': 'base\n' });
    git(repo, 'checkout', '-q', '-b', 'other');
    commitFile(repo, 'f.txt', 'other\n');
    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'f.txt', 'main\n');
    await gitService.mergeBranch(repo, 'other'); // leaves f.txt conflicted
    writeFile(repo, 'added.txt', 'new\n');
    git(repo, 'add', 'added.txt');
    git(repo, 'rm', '-q', 'gone.txt');

    const status = await gitService.getStatus(repo);
    assert.equal(status.staged.find((c) => c.path === 'added.txt')?.status, 'added');
    assert.equal(status.staged.find((c) => c.path === 'gone.txt')?.status, 'deleted');
    assert.equal(status.unstaged.find((c) => c.path === 'f.txt')?.status, 'conflicted');
    git(repo, 'merge', '--abort');
  });

  it('runs a fixed number of git commands however many files changed', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) {
      files[`f${i}.txt`] = 'a\n';
    }
    const repo = initRepo(path.join(scratch('status-perf'), 'repo'), files);
    for (let i = 0; i < 60; i++) {
      writeFile(repo, `f${i}.txt`, 'b\n');
    }
    for (let i = 0; i < 30; i++) {
      writeFile(repo, `new${i}.txt`, 'n\n');
    }
    git(repo, 'add', 'new*.txt');

    const instrumented = new InstrumentedGit();
    const status = await instrumented.getStatus(repo);
    assert.equal(status.unstaged.length, 60);
    assert.equal(status.staged.length, 30);
    // The old implementation ran one extra git process per changed file (90+ here).
    assert.equal(instrumented.commands.length, 3);
  });
});

describe('discard', () => {
  it('never deletes a Claude worktree nested in the main worktree', async () => {
    const repo = initRepo(path.join(scratch('discard-nested'), 'repo'));
    const nested = path.join(repo, '.claude', 'worktrees', 'brave-newton-f60c19');
    git(repo, 'worktree', 'add', '-q', '-b', 'claude/brave-newton-f60c19', nested);
    writeFile(nested, 'work.txt', 'uncommitted agent work\n');

    // Without .claude/worktrees/ in .git/info/exclude, git reports the nested worktree as untracked.
    const entry = (await gitService.getStatus(repo)).unstaged.find((c) => c.path.startsWith('.claude/worktrees'));
    assert.ok(entry, 'expected the nested worktree to show as untracked');

    const discardOne = await gitService.discardChange(repo, entry);
    assert.equal(discardOne.ok, false);
    assert.ok(fs.existsSync(path.join(nested, 'work.txt')));

    assert.equal((await gitService.discardAll(repo)).ok, true);
    assert.ok(fs.existsSync(path.join(nested, 'work.txt')), 'Discard All must leave nested worktrees alone');
  });

  it('deletes an untracked file and restores a modified one, keeping staged changes', async () => {
    const repo = initRepo(path.join(scratch('discard-files'), 'repo'), { 'tracked.txt': 'v1\n' });
    writeFile(repo, 'tracked.txt', 'v2\n');
    git(repo, 'add', 'tracked.txt'); // stage v2
    writeFile(repo, 'tracked.txt', 'v3\n'); // unstaged v3 on top
    writeFile(repo, 'scratch.txt', 'temp\n');

    const status = await gitService.getStatus(repo);
    const modified = status.unstaged.find((c) => c.path === 'tracked.txt')!;
    const untracked = status.unstaged.find((c) => c.path === 'scratch.txt')!;

    assert.equal((await gitService.discardChange(repo, modified)).ok, true);
    assert.equal(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf-8'), 'v2\n', 'restored from the index, not HEAD');
    assert.equal((await gitService.discardChange(repo, untracked)).ok, true);
    assert.ok(!fs.existsSync(path.join(repo, 'scratch.txt')));
  });
});

describe('mergeBranch', () => {
  it('reports conflicted files, leaves the merge for the user, and can abort it', async () => {
    const repo = initRepo(path.join(scratch('merge-conflict'), 'repo'), { 'f.txt': 'base\n' });
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, 'f.txt', 'feature\n');
    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'f.txt', 'main\n');

    const result = await gitService.mergeBranch(repo, 'feature');
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.conflicts.length === 1 && result.conflicts[0] === 'f.txt');
    assert.ok(git(repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim(), 'worktree is mid-merge');

    assert.equal((await gitService.abortMerge(repo)).ok, true);
    assert.equal(fs.readFileSync(path.join(repo, 'f.txt'), 'utf-8'), 'main\n');
  });

  it('merges without waiting for an editor', { timeout: 20_000 }, async () => {
    const repo = initRepo(path.join(scratch('merge-no-editor'), 'repo'), { 'a.txt': 'a\n' });
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, 'b.txt', 'b\n');
    git(repo, 'checkout', '-q', 'main');

    const previous = process.env.GIT_EDITOR;
    process.env.GIT_EDITOR = slowCommand(60_000, 1); // an editor nobody will ever close
    try {
      const result = await gitService.mergeBranch(repo, 'feature');
      assert.deepEqual(result, { ok: true });
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_EDITOR;
      } else {
        process.env.GIT_EDITOR = previous;
      }
    }
  });
});

describe('fetchPullRequest', () => {
  /** An "origin" that publishes refs/pull/7/head, like GitHub does, plus a clone of it. */
  function pullRequestFixture(name: string) {
    const dir = scratch(name);
    const origin = initRepo(path.join(dir, 'origin'));
    git(origin, 'checkout', '-q', '-b', 'contributor-branch');
    const prHead = commitFile(origin, 'pr.txt', 'from the PR\n');
    git(origin, 'checkout', '-q', 'main');
    git(origin, 'update-ref', 'refs/pull/7/head', prHead);
    git(origin, 'branch', '-q', '-D', 'contributor-branch'); // the PR ref is all that's left
    const clone = path.join(dir, 'clone');
    git(dir, 'clone', '-q', origin, clone);
    return { clone, prHead };
  }

  it('fetches the PR head into pr-<n> without checking anything out', async () => {
    const { clone, prHead } = pullRequestFixture('pr-fetch');
    const headBefore = git(clone, 'rev-parse', 'HEAD').trim();
    const reflogBefore = git(clone, 'reflog').trim().split('\n').length;

    const result = await gitService.fetchPullRequest(clone, 7, 'pr-7', 'origin');
    assert.deepEqual(result, { ok: true });
    assert.equal(git(clone, 'rev-parse', 'refs/heads/pr-7').trim(), prHead);

    // The main worktree never moved: same branch, same commit, no new checkout entries.
    assert.equal(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), headBefore);
    assert.equal(git(clone, 'reflog').trim().split('\n').length, reflogBefore);
  });

  it('only fast-forwards an existing pr-<n> branch, never resets it', async () => {
    const { clone } = pullRequestFixture('pr-diverged');
    git(clone, 'checkout', '-q', '-b', 'pr-7');
    const localWork = commitFile(clone, 'local.txt', 'my fix on top of an old PR checkout\n');
    git(clone, 'checkout', '-q', 'main');

    const result = await gitService.fetchPullRequest(clone, 7, 'pr-7', 'origin');
    assert.equal(result.ok, false);
    assert.equal(git(clone, 'rev-parse', 'refs/heads/pr-7').trim(), localWork);
  });

  it('rejects an invalid PR number without running git', async () => {
    const instrumented = new InstrumentedGit();
    const result = await instrumented.fetchPullRequest(tmp, 0, 'pr-0', 'origin');
    assert.equal(result.ok, false);
    assert.equal(instrumented.commands.length, 0);
  });
});

describe('getBranches', () => {
  it('lists local and remote branches without the remote HEAD alias', async () => {
    const dir = scratch('branches');
    const origin = initRepo(path.join(dir, 'origin'));
    git(origin, 'branch', 'feature/remote-only');
    const clone = path.join(dir, 'clone');
    git(dir, 'clone', '-q', origin, clone);

    const branches = await gitService.getBranches(clone);
    assert.deepEqual(branches, ['main', 'origin/feature/remote-only', 'origin/main']);
  });
});

describe('timeouts and cancellation', () => {
  it('kills a git command that runs past its timeout', async () => {
    const instrumented = new InstrumentedGit();
    const started = Date.now();
    await assert.rejects(
      instrumented.runForTest(['-c', `alias.hang=!${slowCommand(5_000)}`, 'hang'], { cwd: tmp, timeoutMs: 300 }),
      (error: unknown) => {
        assert.ok(error instanceof GitError);
        assert.equal(error.timedOut, true);
        assert.equal(describeGitError(error), 'git hang timed out.');
        return true;
      }
    );
    assert.ok(Date.now() - started < 4_000, 'should give up at the timeout, not when the command finishes');
  });

  it('stops a git command when its signal is aborted', async () => {
    const instrumented = new InstrumentedGit();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(
      instrumented.runForTest(['-c', `alias.hang=!${slowCommand(5_000)}`, 'hang'], { cwd: tmp, signal: controller.signal }),
      (error: unknown) => error instanceof GitError && error.cancelled
    );
  });

  it('continues a rebase without waiting for an editor, even when GIT_EDITOR is set', { timeout: 30_000 }, async () => {
    const repo = initRepo(path.join(scratch('rebase-continue'), 'repo'), { 'f.txt': 'base\n' });
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, 'f.txt', 'feature\n');
    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'f.txt', 'main\n');
    git(repo, 'checkout', '-q', 'feature');

    const rebase = await gitService.rebase(repo, 'main');
    assert.equal(rebase.ok, false);
    assert.equal(await gitService.isRebaseInProgress(repo), true);
    writeFile(repo, 'f.txt', 'resolved\n');
    git(repo, 'add', 'f.txt');

    const previous = process.env.GIT_EDITOR;
    process.env.GIT_EDITOR = slowCommand(60_000, 1); // would hang the old code until the timeout
    try {
      assert.deepEqual(await gitService.rebaseContinue(repo), { ok: true });
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_EDITOR;
      } else {
        process.env.GIT_EDITOR = previous;
      }
    }
    assert.equal(await gitService.isRebaseInProgress(repo), false);
  });
});

describe('checkRebaseConflicts', () => {
  it('predicts conflicting files without touching the worktree', async () => {
    const repo = initRepo(path.join(scratch('rebase-check'), 'repo'), { 'f.txt': 'base\n', 'g.txt': 'g\n' });
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, 'f.txt', 'feature\n');
    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'f.txt', 'main\n');
    git(repo, 'checkout', '-q', 'feature');

    const check = await gitService.checkRebaseConflicts(repo, 'main');
    assert.deepEqual(check, { checked: true, hasConflicts: true, conflictingFiles: ['f.txt'] });
    assert.equal(fs.readFileSync(path.join(repo, 'f.txt'), 'utf-8'), 'feature\n');
  });
});

// Known bugs from the review that are not fixed yet. `todo` tests run and report, but
// don't fail the suite; they pass once the bug is fixed.
describe('known bugs (todo)', () => {
  it('Stage All does not stage a nested Claude worktree as an embedded repository', { todo: 'stageAll uses git add -A, which adds .claude/worktrees/* as gitlinks unless they are excluded' }, async () => {
    const repo = initRepo(path.join(scratch('todo-stage-all'), 'repo'));
    git(repo, 'worktree', 'add', '-q', '-b', 'claude/x', path.join(repo, '.claude', 'worktrees', 'x'));
    await gitService.stageAll(repo);
    assert.equal(git(repo, 'ls-files', '-s', '.claude').trim(), '');
  });

  it('getRepoRoot returns the main repository when called from a linked worktree', { todo: 'Add Repository from inside a Claude worktree records the worktree as the repository' }, async () => {
    const repo = initRepo(path.join(scratch('todo-repo-root'), 'repo'));
    const nested = path.join(repo, '.claude', 'worktrees', 'x');
    git(repo, 'worktree', 'add', '-q', '-b', 'claude/x', nested);
    const root = await gitService.getRepoRoot(nested);
    assert.ok(root && samePath(root, repo));
  });

  it('creates a local branch when a remote branch is picked as an existing branch', { todo: 'picking origin/<branch> in Create Worktree makes a detached worktree' }, async () => {
    const dir = scratch('todo-remote-branch');
    const origin = initRepo(path.join(dir, 'origin'));
    git(origin, 'branch', 'feature/remote-only');
    const clone = path.join(dir, 'clone');
    git(dir, 'clone', '-q', origin, clone);
    const worktreePath = path.join(dir, 'clone-worktrees', 'remote-only');
    await gitService.createWorktree(clone, 'origin/feature/remote-only', worktreePath);
    assert.notEqual(git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD');
  });
});
