import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { isWithin, resolveNewEntryPath, samePath } from '../utils/paths';

const root = path.join(os.tmpdir(), 'agntree-paths', 'worktree');
const src = path.join(root, 'src');

describe('resolveNewEntryPath', () => {
  it('resolves a name, or a nested path, inside the folder', () => {
    assert.deepEqual(resolveNewEntryPath(root, src, 'index.ts'), { ok: true, path: path.join(src, 'index.ts') });
    assert.deepEqual(resolveNewEntryPath(root, src, 'utils/strings.ts'), { ok: true, path: path.join(src, 'utils', 'strings.ts') });
    assert.deepEqual(resolveNewEntryPath(root, src, '../README.md'), { ok: true, path: path.join(root, 'README.md') });
  });

  it('refuses names that escape the worktree', () => {
    for (const name of ['../../outside.txt', '../../../etc/passwd', `..${path.sep}..${path.sep}x`]) {
      const result = resolveNewEntryPath(root, src, name);
      assert.equal(result.ok, false, name);
    }
  });

  it('refuses absolute paths, empty names, and names that resolve to the folder itself', () => {
    for (const name of ['', '   ', '.', 'sub/..', path.join(root, 'abs.txt'), '/abs.txt']) {
      assert.equal(resolveNewEntryPath(root, src, name).ok, false, JSON.stringify(name));
    }
    assert.equal(resolveNewEntryPath(root, root, '..').ok, false);
  });
});

describe('isWithin', () => {
  it('accepts the root and its descendants only', () => {
    assert.equal(isWithin(root, root), true);
    assert.equal(isWithin(root, path.join(root, 'a', 'b')), true);
    assert.equal(isWithin(root, path.dirname(root)), false);
    assert.equal(isWithin(root, `${root}-sibling`), false);
    assert.equal(isWithin(root, path.join(root, '..notes')), true, 'a name starting with ".." is still inside');
  });
});

describe('samePath', () => {
  it('ignores separators, trailing slashes and ".." segments', () => {
    assert.equal(samePath(path.join(root, 'a'), `${root}${path.sep}b${path.sep}..${path.sep}a${path.sep}`), true);
    assert.equal(samePath(path.join(root, 'a'), path.join(root, 'b')), false);
  });

  it('matches git-style and VS Code-style Windows paths', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
    assert.equal(samePath('P:/Source/agntree', 'p:\\Source\\agntree'), true);
  });

  it('is case-sensitive on Linux', { skip: process.platform !== 'linux' && 'Linux only' }, () => {
    assert.equal(samePath('/home/coder/Repo', '/home/coder/repo'), false);
  });
});
