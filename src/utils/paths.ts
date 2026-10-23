import * as path from 'path';

/**
 * Whether two paths refer to the same location. Normalizes separators and `..`
 * segments, and ignores case on Windows (git prints `C:/x`, VS Code gives `c:\x`).
 */
export function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** Whether `target` is `root` itself or somewhere inside it. */
export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export type NewEntryPath = { ok: true; path: string } | { ok: false; error: string };

/**
 * Resolve the path for a file or folder the user is creating or renaming to.
 * `name` may contain subfolders (`src/new.ts`), but the result must stay inside
 * `rootDir` (the worktree) and must not be `parentDir` itself.
 */
export function resolveNewEntryPath(rootDir: string, parentDir: string, name: string): NewEntryPath {
  if (!name || name.trim().length === 0) {
    return { ok: false, error: 'A name is required.' };
  }
  if (path.isAbsolute(name) || /^[\\/]/.test(name)) {
    return { ok: false, error: 'Enter a name relative to the selected folder, not an absolute path.' };
  }
  const target = path.resolve(parentDir, name);
  if (!isWithin(rootDir, target) || samePath(target, rootDir)) {
    return { ok: false, error: `"${name}" would be outside this worktree.` };
  }
  if (samePath(target, parentDir)) {
    return { ok: false, error: `"${name}" is not a valid name.` };
  }
  return { ok: true, path: target };
}
