import { samePath } from './paths';

/**
 * The repositories to add for the folders open in the window: each folder's repository
 * (see `GitService.getRepoRoot`, which gives the main worktree for a linked one), skipping
 * folders outside git and repositories already known or already found for another folder.
 * On a Coder devbox every start is a new machine with nothing saved, so this is how the
 * checkout in `~/work/<repo>` shows up without "Add Repository".
 */
export async function repositoriesForFolders(
  folders: string[],
  knownRoots: string[],
  getRepoRoot: (dir: string) => Promise<string | null>
): Promise<string[]> {
  const found: string[] = [];
  for (const folder of folders) {
    const root = await getRepoRoot(folder);
    if (root && ![...knownRoots, ...found].some((known) => samePath(known, root))) {
      found.push(root);
    }
  }
  return found;
}
