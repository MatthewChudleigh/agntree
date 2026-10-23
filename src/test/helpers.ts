import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Run every git command in these tests (including GitService's) without the developer's
// own config: commit signing, hooks, autocrlf, or a different default branch would all
// change the results.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-gitconfig-'));
const emptyConfig = path.join(configDir, 'gitconfig');
fs.writeFileSync(emptyConfig, '');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_AUTHOR_NAME = 'Agntree Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Agntree Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR']) {
  delete process.env[name];
}

/** A new empty directory under the OS temp dir. */
export function makeTempDir(prefix = 'agntree-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Run git synchronously, for test setup and assertions only. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

export function writeFile(dir: string, relativePath: string, content: string): void {
  const filePath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** `git init` a repository on `main` with one commit of `files`. */
export function initRepo(dir: string, files: Record<string, string> = { 'README.md': 'hello\n' }): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [name, content] of Object.entries(files)) {
    writeFile(dir, name, content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

/** Write a file and commit it. Returns the new commit SHA. */
export function commitFile(repo: string, relativePath: string, content: string, message = `update ${relativePath}`): string {
  writeFile(repo, relativePath, content);
  git(repo, 'add', '--', relativePath);
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD').trim();
}

/**
 * A shell command that does nothing for `ms` then exits with `exitCode`. Used as a git
 * alias or editor to simulate a hung process. Runs Node itself, so it works anywhere
 * these tests run (git executes it through its own shell, also on Windows).
 */
export function slowCommand(ms: number, exitCode = 0): string {
  const node = process.execPath.replace(/\\/g, '/');
  return `"${node}" -e "setTimeout(() => process.exit(${exitCode}), ${ms})"`;
}
