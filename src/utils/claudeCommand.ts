/**
 * Building the `claude` command line that Agntree types into a session's terminal.
 */

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `id` looks like a Claude Code session ID (a UUID). Session IDs come from log
 * file names and are typed into a shell, so anything else is refused.
 */
export function isSessionId(id: string | null | undefined): id is string {
  return typeof id === 'string' && SESSION_ID.test(id);
}

export type ClaudeLaunch =
  /** Resume an existing session */
  | { resume: string }
  /** Start a new session with an ID chosen in advance, so the log can be found by name */
  | { newSessionId: string }
  /** Start a new session `newSessionId` from a copy of session `forkFrom`'s history */
  | { forkFrom: string; newSessionId: string };

/** The command for a launch, or null if an ID isn't a valid session ID. */
export function claudeCommand(launch: ClaudeLaunch): string | null {
  if ('resume' in launch) {
    return isSessionId(launch.resume) ? `claude --resume ${launch.resume}` : null;
  }
  if (!isSessionId(launch.newSessionId)) {
    return null;
  }
  if ('forkFrom' in launch) {
    // `--session-id` is only accepted with `--resume` when `--fork-session` is given too.
    return isSessionId(launch.forkFrom)
      ? `claude --resume ${launch.forkFrom} --fork-session --session-id ${launch.newSessionId}`
      : null;
  }
  return `claude --session-id ${launch.newSessionId}`;
}
