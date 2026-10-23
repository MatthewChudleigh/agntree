import * as vscode from 'vscode';
import * as path from 'path';
import { FileTreeItem, FilesTreeProvider } from '../providers/FilesTreeProvider';
import { resolveNewEntryPath, samePath } from '../utils/paths';

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (err) {
    // Anything other than "not found" (e.g. permissions) counts as taken, to be safe.
    return !(err instanceof vscode.FileSystemError && err.code === 'FileNotFound');
  }
}

/**
 * Input box validation for a new file/folder name: it must stay inside the worktree
 * and must not already exist. `workspace.fs.writeFile` overwrites, so without the
 * existence check "New File" with an existing name would silently empty that file.
 * `ignorePath` is the entry being renamed, so a case-only rename isn't refused.
 */
function validateNewEntryName(rootDir: string, parentDir: string, ignorePath?: string) {
  return async (value: string): Promise<string | undefined> => {
    const resolved = resolveNewEntryPath(rootDir, parentDir, value);
    if (!resolved.ok) {
      return resolved.error;
    }
    if (ignorePath && samePath(resolved.path, ignorePath)) {
      return undefined;
    }
    if (await pathExists(vscode.Uri.file(resolved.path))) {
      return `"${value}" already exists.`;
    }
    return undefined;
  };
}

/** The folder a new entry goes in: the selected folder, a selected file's folder, or the worktree root. */
function targetFolder(item: FileTreeItem | undefined, rootDir: string): string {
  if (!item) {
    return rootDir;
  }
  const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
  return isFolder ? item.uri.fsPath : path.dirname(item.uri.fsPath);
}

async function uniqueDestUri(targetDirUri: vscode.Uri, sourceUri: vscode.Uri): Promise<vscode.Uri> {
  const name = path.basename(sourceUri.fsPath);
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;

  let candidate = vscode.Uri.joinPath(targetDirUri, name);
  let counter = 0;

  while (true) {
    try {
      await vscode.workspace.fs.stat(candidate);
      // File exists — generate a new name
      counter++;
      const suffix = counter === 1 ? ' copy' : ` copy ${counter}`;
      candidate = vscode.Uri.joinPath(targetDirUri, `${base}${suffix}${ext}`);
    } catch {
      // stat threw → file does not exist, this name is free
      return candidate;
    }
  }
}

export function registerFileCommands(
  context: vscode.ExtensionContext,
  filesProvider: FilesTreeProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.files.search', () => {
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      vscode.commands.executeCommand('workbench.action.findInFiles', {
        filesToInclude: worktree.path,
      });
    }),

    vscode.commands.registerCommand('agntree.files.refresh', () => {
      filesProvider.refresh();
    }),

    vscode.commands.registerCommand('agntree.files.openToSide', (item: FileTreeItem) => {
      vscode.commands.executeCommand('vscode.open', item.uri, vscode.ViewColumn.Beside);
    }),

    vscode.commands.registerCommand('agntree.files.revealInFinder', (item: FileTreeItem) => {
      // The menu item is hidden in remote windows, where revealFileInOS silently does nothing.
      if (vscode.env.remoteName) {
        vscode.window.showInformationMessage(`Can't reveal files in the OS file manager in a remote (${vscode.env.remoteName}) window.`);
        return;
      }
      vscode.commands.executeCommand('revealFileInOS', item.uri);
    }),

    vscode.commands.registerCommand('agntree.files.openInTerminal', (item: FileTreeItem) => {
      const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
      const cwd = isFolder ? item.uri.fsPath : path.dirname(item.uri.fsPath);
      vscode.window.createTerminal({ cwd }).show();
    }),

    vscode.commands.registerCommand('agntree.files.copyPath', (item: FileTreeItem) => {
      vscode.env.clipboard.writeText(item.uri.fsPath);
    }),

    vscode.commands.registerCommand('agntree.files.copyRelativePath', (item: FileTreeItem) => {
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      vscode.env.clipboard.writeText(path.relative(worktree.path, item.uri.fsPath));
    }),

    vscode.commands.registerCommand('agntree.files.rename', async (item: FileTreeItem) => {
      const oldName = path.basename(item.uri.fsPath);
      const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
      const dotIndex = oldName.lastIndexOf('.');
      const selectionEnd = (!isFolder && dotIndex > 0) ? dotIndex : oldName.length;
      const parentDir = path.dirname(item.uri.fsPath);
      const rootDir = filesProvider.getActiveWorktree()?.path ?? parentDir;

      const newName = await vscode.window.showInputBox({
        prompt: 'Enter new name',
        value: oldName,
        valueSelection: [0, selectionEnd],
        validateInput: validateNewEntryName(rootDir, parentDir, item.uri.fsPath),
      });
      if (!newName || newName === oldName) { return; }

      const resolved = resolveNewEntryPath(rootDir, parentDir, newName);
      if (!resolved.ok) {
        vscode.window.showErrorMessage(resolved.error);
        return;
      }
      const newUri = vscode.Uri.file(resolved.path);
      try {
        await vscode.workspace.fs.rename(item.uri, newUri, { overwrite: false });
        filesProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Rename failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('agntree.files.delete', async (item: FileTreeItem) => {
      const name = path.basename(item.uri.fsPath);
      const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
      const kind = isFolder ? 'folder' : 'file';
      // Remote windows (Remote-SSH, which Coder uses, WSL, containers) have no trash, and
      // VS Code refuses useTrash there, so say up front that the delete is permanent.
      const remote = vscode.env.remoteName;
      const answer = await vscode.window.showWarningMessage(
        remote ? `Permanently delete ${kind} "${name}"?` : `Delete ${kind} "${name}"?`,
        {
          modal: true,
          detail: remote ? `This can't be undone: there is no trash in a remote (${remote}) window.` : 'You can restore it from the trash.',
        },
        'Delete'
      );
      if (answer !== 'Delete') { return; }

      const deletePermanently = async () => {
        await vscode.workspace.fs.delete(item.uri, { recursive: isFolder, useTrash: false });
        filesProvider.refresh();
      };
      try {
        if (remote) {
          await deletePermanently();
          return;
        }
        try {
          await vscode.workspace.fs.delete(item.uri, { recursive: isFolder, useTrash: true });
          filesProvider.refresh();
        } catch (trashError) {
          const retry = await vscode.window.showWarningMessage(
            `Couldn't move "${name}" to the trash. Delete it permanently?`,
            { modal: true, detail: `${trashError}` },
            'Delete Permanently'
          );
          if (retry === 'Delete Permanently') {
            await deletePermanently();
          }
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Delete failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('agntree.files.newFile', async (item?: FileTreeItem) => {
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      const parentPath = targetFolder(item, worktree.path);
      const name = await vscode.window.showInputBox({
        prompt: 'File name',
        validateInput: validateNewEntryName(worktree.path, parentPath),
      });
      if (!name) { return; }
      const resolved = resolveNewEntryPath(worktree.path, parentPath, name);
      if (!resolved.ok) {
        vscode.window.showErrorMessage(resolved.error);
        return;
      }
      const newUri = vscode.Uri.file(resolved.path);
      // Check again right before writing: writeFile would replace an existing file's contents.
      if (await pathExists(newUri)) {
        vscode.window.showErrorMessage(`"${name}" already exists.`);
        return;
      }
      try {
        await vscode.workspace.fs.writeFile(newUri, new Uint8Array());
        filesProvider.refresh();
        vscode.commands.executeCommand('vscode.open', newUri);
      } catch (err) {
        vscode.window.showErrorMessage(`Could not create file: ${err}`);
      }
    }),

    vscode.commands.registerCommand('agntree.files.newFolder', async (item?: FileTreeItem) => {
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      const parentPath = targetFolder(item, worktree.path);
      const name = await vscode.window.showInputBox({
        prompt: 'Folder name',
        validateInput: validateNewEntryName(worktree.path, parentPath),
      });
      if (!name) { return; }
      const resolved = resolveNewEntryPath(worktree.path, parentPath, name);
      if (!resolved.ok) {
        vscode.window.showErrorMessage(resolved.error);
        return;
      }
      const newUri = vscode.Uri.file(resolved.path);
      if (await pathExists(newUri)) {
        vscode.window.showErrorMessage(`"${name}" already exists.`);
        return;
      }
      try {
        await vscode.workspace.fs.createDirectory(newUri);
        filesProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Could not create folder: ${err}`);
      }
    }),

    vscode.commands.registerCommand('agntree.files.copy', (item: FileTreeItem) => {
      filesProvider.setClipboard(item.uri, false);
      vscode.window.setStatusBarMessage(`Copied: ${path.basename(item.uri.fsPath)}`, 3000);
    }),

    vscode.commands.registerCommand('agntree.files.cut', (item: FileTreeItem) => {
      filesProvider.setClipboard(item.uri, true);
      vscode.window.setStatusBarMessage(`Cut: ${path.basename(item.uri.fsPath)}`, 3000);
    }),

    vscode.commands.registerCommand('agntree.files.paste', async (item?: FileTreeItem) => {
      const clipboard = filesProvider.getClipboard();
      if (!clipboard) { return; }

      const worktree = filesProvider.getActiveWorktree();

      // Resolve target directory: folder item → that folder, file item → its parent, no item → worktree root
      let targetDir: string | undefined;
      if (item) {
        const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
        targetDir = isFolder ? item.uri.fsPath : path.dirname(item.uri.fsPath);
      } else {
        targetDir = worktree?.path;
      }
      if (!targetDir) { return; }

      const destUri = await uniqueDestUri(vscode.Uri.file(targetDir), clipboard.uri);
      try {
        if (clipboard.isCut) {
          await vscode.workspace.fs.rename(clipboard.uri, destUri, { overwrite: false });
          filesProvider.clearClipboard();
        } else {
          await vscode.workspace.fs.copy(clipboard.uri, destUri, { overwrite: false });
        }
        filesProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Paste failed: ${err}`);
      }
    })
  );
}
