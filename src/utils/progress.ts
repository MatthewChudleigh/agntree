import * as vscode from 'vscode';

/**
 * Run `task` under a cancellable progress notification. Cancelling aborts the signal,
 * which kills the git command passed it.
 */
export function withCancellableProgress<T>(title: string, task: (signal: AbortSignal) => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (_progress, token) => {
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => controller.abort());
      try {
        return await task(controller.signal);
      } finally {
        subscription.dispose();
      }
    }
  );
}

/** Run `task` under a (non-cancellable) progress notification. */
export function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}
