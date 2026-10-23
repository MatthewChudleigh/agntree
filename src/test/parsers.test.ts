import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildWorkingTreeStatus, parseNumstatZ, parseStatusV2, parseWorktreeList } from '../services/GitService';

describe('parseWorktreeList', () => {
  it('reads branches, detached and bare entries; the first entry is the main worktree', () => {
    const output = [
      'worktree /repos/app',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /repos/app/.claude/worktrees/eager-feynman-8ff4f6',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/claude/eager-feynman-8ff4f6',
      'locked',
      '',
      'worktree /repos/app-worktrees/mid-rebase',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');

    assert.deepEqual(parseWorktreeList(output), [
      { path: '/repos/app', head: '1111111111111111111111111111111111111111', branch: 'main', detached: false, bare: false },
      {
        path: '/repos/app/.claude/worktrees/eager-feynman-8ff4f6',
        head: '2222222222222222222222222222222222222222',
        branch: 'claude/eager-feynman-8ff4f6',
        detached: false,
        bare: false,
      },
      { path: '/repos/app-worktrees/mid-rebase', head: '3333333333333333333333333333333333333333', branch: null, detached: true, bare: false },
    ]);
  });

  it('flags a bare repository entry', () => {
    const entries = parseWorktreeList('worktree /repos/app.git\nbare\n\nworktree /repos/wt\nHEAD abc\nbranch refs/heads/main\n');
    assert.equal(entries[0].bare, true);
    assert.equal(entries[1].bare, false);
  });

  it('tolerates CRLF line endings', () => {
    const entries = parseWorktreeList('worktree C:/repos/app\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\n');
    assert.deepEqual(entries, [{ path: 'C:/repos/app', head: 'abc', branch: 'main', detached: false, bare: false }]);
  });
});

describe('parseStatusV2', () => {
  it('parses changed, renamed, unmerged, untracked and ignored entries, including spaces in paths', () => {
    const output = [
      '# branch.oid 1111111111111111111111111111111111111111',
      '# branch.head main',
      '1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa src/my file.ts',
      '2 R. N... 100644 100644 100644 bbbbbbb bbbbbbb R100 src/new name.ts',
      'src/old name.ts',
      'u UU N... 100644 100644 100644 100644 c1 c2 c3 conflict.txt',
      '? notes/todo.md',
      '! build/output.js',
      '',
    ].join('\0');

    assert.deepEqual(parseStatusV2(output), [
      { kind: 'changed', index: '.', worktree: 'M', path: 'src/my file.ts' },
      { kind: 'renamed', index: 'R', worktree: '.', path: 'src/new name.ts', origPath: 'src/old name.ts' },
      { kind: 'unmerged', index: 'U', worktree: 'U', path: 'conflict.txt' },
      { kind: 'untracked', index: '?', worktree: '?', path: 'notes/todo.md' },
      { kind: 'ignored', index: '!', worktree: '!', path: 'build/output.js' },
    ]);
  });

  it('returns nothing for a clean worktree', () => {
    assert.deepEqual(parseStatusV2('# branch.oid abc\0# branch.head main\0'), []);
    assert.deepEqual(parseStatusV2(''), []);
  });
});

describe('parseNumstatZ', () => {
  it('reads counts, treats binary files as zero, and keys renames by their new path', () => {
    const output = ['3\t1\tsrc/app.ts', '-\t-\tlogo.png', '5\t0\t', 'src/old.ts', 'src/new.ts', ''].join('\0');
    const counts = parseNumstatZ(output);
    assert.deepEqual(counts.get('src/app.ts'), { additions: 3, deletions: 1 });
    assert.deepEqual(counts.get('logo.png'), { additions: 0, deletions: 0 });
    assert.deepEqual(counts.get('src/new.ts'), { additions: 5, deletions: 0 });
    assert.equal(counts.has('src/old.ts'), false);
  });
});

describe('buildWorkingTreeStatus', () => {
  it('splits staged and unstaged sides of the same file and maps status letters', () => {
    const entries = parseStatusV2(
      [
        '1 MM N... 100644 100644 100644 a a both.ts',
        '1 A. N... 000000 100644 100644 0 b added.ts',
        '1 .D N... 100644 100644 000000 c c deleted.ts',
        '1 D. N... 100644 000000 000000 d 0 removed.ts',
        '2 R. N... 100644 100644 100644 e e R90 renamed.ts',
        'was.ts',
        'u UU N... 100644 100644 100644 100644 f g h conflict.ts',
        '? new.txt',
        '',
      ].join('\0')
    );
    const staged = new Map([['both.ts', { additions: 2, deletions: 0 }]]);
    const unstaged = new Map([['both.ts', { additions: 0, deletions: 1 }]]);

    const status = buildWorkingTreeStatus(entries, staged, unstaged);
    assert.deepEqual(status.staged, [
      { path: 'both.ts', status: 'modified', additions: 2, deletions: 0 },
      { path: 'added.ts', status: 'added', additions: 0, deletions: 0 },
      { path: 'removed.ts', status: 'deleted', additions: 0, deletions: 0 },
      { path: 'renamed.ts', origPath: 'was.ts', status: 'renamed', additions: 0, deletions: 0 },
    ]);
    assert.deepEqual(status.unstaged, [
      { path: 'both.ts', status: 'modified', additions: 0, deletions: 1 },
      { path: 'deleted.ts', status: 'deleted', additions: 0, deletions: 0 },
      { path: 'conflict.ts', status: 'conflicted', additions: 0, deletions: 0 },
      { path: 'new.txt', status: 'untracked', additions: 0, deletions: 0 },
    ]);
  });
});
