import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { StateStore, adoptStateFile, migrateLegacyState } from '../services/StateStore';
import { ChatSession, Repository } from '../types';
import { makeTempDir, removeDir } from './helpers';

let tmp: string;
before(() => {
  tmp = makeTempDir('agntree-storage-');
});
after(() => {
  removeDir(tmp);
});

let counter = 0;
const stateFile = () => path.join(tmp, `case-${++counter}`, 'state.json');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chat(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    worktreeId: 'wt-1',
    name: `Chat ${id}`,
    claudeSessionId: `session-${id}`,
    createdAt: 1,
    lastAccessedAt: 1,
    status: 'active',
    baseCommit: null,
    ...overrides,
  };
}

describe('StateStore', () => {
  it("keeps both windows' changes when two windows save to the same file", () => {
    const file = stateFile();
    const windowA = new StateStore(file);
    const windowB = new StateStore(file);
    windowA.read();
    windowB.read(); // both have the file cached before either writes

    windowA.update((state) => state.chats.push(chat('a')));
    windowB.update((state) => state.chats.push(chat('b')));

    assert.deepEqual(new StateStore(file).read().chats.map((c) => c.id), ['a', 'b']);
    assert.deepEqual(windowA.read().chats.map((c) => c.id), ['a', 'b']);
  });

  it('loses no changes when two windows save at the same time', async () => {
    const file = stateFile();
    new StateStore(file).write(new StateStore(file).read());
    // Tests run from out-test/; the fixture is built next to them.
    const writer = path.join(__dirname, 'fixtures', 'stateWriter.js');
    const run = (prefix: string) =>
      new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [writer, file, prefix, '150'], { stdio: 'inherit' });
        child.on('close', resolve);
      });
    assert.deepEqual(await Promise.all([run('a'), run('b')]), [0, 0]);

    const saved = new StateStore(file).read().starredChats;
    assert.equal(saved.length, 300, `${300 - saved.length} changes were lost`);
    assert.equal(new Set(saved).size, 300);
  });

  it("doesn't save over the file when it can't be read", () => {
    const file = stateFile();
    const store = new StateStore(file);
    store.update((state) => state.chats.push(chat('keep-me')));
    // A folder in the file's place makes reading fail with an error other than "not found".
    const real = `${file}.real`;
    fs.renameSync(file, real);
    fs.mkdirSync(file);
    try {
      assert.throws(() => store.update((state) => state.chats.push(chat('new'))));
    } finally {
      fs.rmdirSync(file);
      fs.renameSync(real, file);
    }
    assert.deepEqual(new StateStore(file).read().chats.map((c) => c.id), ['keep-me']);
    assert.ok(!fs.existsSync(`${file}.lock`), 'the lock was not released');
  });

  it('writes the migrated state only if no other window has created the file', () => {
    const file = stateFile();
    const first = new StateStore(file);
    assert.equal(first.writeIfMissing({ ...first.read(), starredChats: ['first'] }), true);
    assert.equal(new StateStore(file).writeIfMissing({ ...first.read(), starredChats: ['second'] }), false);
    assert.deepEqual(new StateStore(file).read().starredChats, ['first']);
  });

  it('takes over a lock left behind by a window that crashed mid-save', () => {
    const file = stateFile();
    const store = new StateStore(file);
    store.write(store.read());
    fs.writeFileSync(`${file}.lock`, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.lock`, old, old);
    store.update((state) => state.starredChats.push('after-crash'));
    assert.deepEqual(new StateStore(file).read().starredChats, ['after-crash']);
  });

  it("sees another window's changes on the next read", () => {
    const file = stateFile();
    const windowA = new StateStore(file);
    const windowB = new StateStore(file);
    assert.deepEqual(windowA.read().repositories, []);
    windowB.update((state) => state.repositories.push({ id: 'r', name: 'repo', rootPath: '/home/coder/repo' }));
    assert.equal(windowA.read().repositories.length, 1);
  });

  it('moves an unreadable file aside instead of overwriting it', () => {
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"chats": [ truncated');
    const store = new StateStore(file);
    assert.deepEqual(store.read().chats, []);
    const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(file), backups[0]), 'utf-8'), '{"chats": [ truncated');
  });

  it('reports changes made by another window, but not its own', async () => {
    const file = stateFile();
    const store = new StateStore(file);
    store.write(store.read());
    let changes = 0;
    const watcher = store.watch(() => changes++);
    try {
      store.update((state) => state.starredChats.push('mine'));
      await sleep(500);
      assert.equal(changes, 0);

      new StateStore(file).update((state) => state.starredChats.push('theirs'));
      const deadline = Date.now() + 5000;
      while (changes === 0 && Date.now() < deadline) {
        await sleep(50);
      }
      assert.ok(changes > 0, 'no change event for the other window');
    } finally {
      watcher.dispose();
    }
  });
});

describe('migrateLegacyState', () => {
  const repo = (id: string, rootPath: string): Repository => ({ id, name: id, rootPath });

  it("keeps only this machine's repositories and sessions from the shared globalState", () => {
    const state = migrateLegacyState(
      {
        repositories: [repo('here', '/home/coder/app'), repo('elsewhere', 'C:\\Source\\app')],
        chats: [
          chat('mine'),
          chat('other-workspace', { claudeSessionId: 'session-not-on-this-machine' }),
          chat('never-started', { claudeSessionId: null }),
        ],
        prWorktrees: { 'wt-1': 12 },
        starredChats: ['mine', 'other-workspace'],
      },
      {
        pathExists: (p) => p === '/home/coder/app',
        sessionExists: (id) => id === 'session-mine',
      }
    );

    assert.deepEqual(state.repositories.map((r) => r.id), ['here']);
    assert.deepEqual(state.chats.map((c) => c.id), ['mine']);
    assert.equal(state.chats[0].status, 'idle'); // no terminal is open yet on this machine
    assert.deepEqual(state.starredChats, ['mine']);
    assert.deepEqual(state.prWorktrees, { 'wt-1': 12 });
  });

  it('starts empty when nothing was saved before', () => {
    const state = migrateLegacyState({}, { pathExists: () => true, sessionExists: () => true });
    assert.deepEqual(state, { version: 1, repositories: [], chats: [], prWorktrees: {}, starredChats: [] });
  });
});

describe('adoptStateFile', () => {
  // VS Code names each extension's storage folder after its ID, so the renamed fork
  // (fullhousevenues.agntree) looks for state.json next to the old one (subhashkhileri.agntree).
  function storageFolders(): { old: string; renamed: string } {
    const globalStorage = path.dirname(stateFile());
    return {
      old: path.join(globalStorage, 'subhashkhileri.agntree', 'state.json'),
      renamed: path.join(globalStorage, 'fullhousevenues.agntree', 'state.json'),
    };
  }

  it("copies the old ID's saved repositories and sessions once", () => {
    const { old, renamed } = storageFolders();
    const repo: Repository = { id: 'r1', name: 'repo', rootPath: '/home/dev/work/repo' };
    new StateStore(old).update((state) => {
      state.repositories.push(repo);
      state.chats.push(chat('a'));
    });

    const target = new StateStore(renamed);
    assert.equal(adoptStateFile(old, target), true);
    assert.deepEqual(target.read().repositories, [repo]);
    assert.deepEqual(target.read().chats.map((c) => c.id), ['a']);

    // Later changes under the new ID are never replaced by the old file
    target.update((state) => {
      state.chats = [];
    });
    assert.equal(adoptStateFile(old, target), false);
    assert.deepEqual(new StateStore(renamed).read().chats, []);
  });

  it('copies nothing when the old ID saved nothing, or saved a file that is not JSON', () => {
    const { old, renamed } = storageFolders();
    const target = new StateStore(renamed);
    assert.equal(adoptStateFile(old, target), false);

    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, '{ not json');
    assert.equal(adoptStateFile(old, target), false);
    assert.equal(target.exists(), false);
  });
});
