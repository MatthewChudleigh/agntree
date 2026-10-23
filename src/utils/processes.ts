import { ChildProcess, spawn } from 'child_process';

/** What a quick action runs: a shell command line, or a program with an argument array. */
export type ProcessSpec = { command: string } | { file: string; args: string[] };

/**
 * Start a process so that it and everything it starts can be stopped together.
 * On Linux and macOS the process leads its own process group (`detached`), which
 * {@link killProcessTree} signals as a whole; Windows uses `taskkill /T` instead.
 */
export function spawnProcessTree(spec: ProcessSpec, cwd: string): ChildProcess {
  const options = {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe')[],
    detached: process.platform !== 'win32',
    windowsHide: true,
  };
  return 'command' in spec
    ? spawn(spec.command, { ...options, shell: true })
    : spawn(spec.file, spec.args, options);
}

/**
 * Stop a process started by {@link spawnProcessTree} together with its children.
 * Signalling only the process itself would leave a shell's children running: for
 * `npm test && npm run lint`, SIGTERM to the shell doesn't reach npm.
 */
export function killProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
  if (!child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {
      child.kill();
    });
    return;
  }
  try {
    // A negative PID signals the whole process group.
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export interface StopOptions {
  /** Time to exit after SIGTERM before the tree is killed with SIGKILL */
  killAfterMs: number;
  /** Time after SIGKILL before giving up on the process reporting that it has finished */
  giveUpAfterMs: number;
  /**
   * Whether the action has finished (its output closed). The child alone isn't enough:
   * for a shell command it is the shell, which SIGTERM ends while its children run on.
   */
  isDone: () => boolean;
  /**
   * Called if it still hasn't finished after SIGKILL, e.g. because a process that left the
   * group still holds its output open. The caller should stop treating it as running.
   */
  onGiveUp: () => void;
}

/** Stop a process tree: SIGTERM, then SIGKILL, then give up. Returns a way to cancel the timers. */
export function stopProcessTree(child: ChildProcess, options: StopOptions): { cancel(): void } {
  killProcessTree(child, 'SIGTERM');
  let timer: NodeJS.Timeout | undefined = setTimeout(() => {
    if (options.isDone()) {
      return;
    }
    killProcessTree(child, 'SIGKILL');
    timer = setTimeout(() => {
      if (!options.isDone()) {
        options.onGiveUp();
      }
    }, options.giveUpAfterMs);
  }, options.killAfterMs);
  return {
    cancel: () => clearTimeout(timer),
  };
}
