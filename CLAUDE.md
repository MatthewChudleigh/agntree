# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
npm install                      # Install dependencies
npm run compile                  # Build the extension
npm run watch                    # Build with auto-rebuild on changes
npm run typecheck                # Type-check (esbuild alone does not)
npm test                         # Type-check, then run the unit tests
npm run lint                     # Run ESLint
npx @vscode/vsce package         # Package as .vsix for installation
code --install-extension *.vsix  # Install the packaged extension
```

To test during development: Press F5 in VS Code to launch the Extension Development Host.

## Unit Tests

Tests live in `src/test/*.test.ts` and use Node's built-in test runner (`node:test`). `scripts/test.js` bundles them with esbuild into `out-test/` and runs `node --test`, so there are no extra test dependencies.

- Tests cover code that doesn't import `vscode`: `GitService` (against real temporary git repositories), `ClaudeSessionService` (against a fake `~/.claude`), `StateStore`, and the helpers in `src/utils/`. Keep logic you want tested out of the command and provider files.
- `src/test/helpers.ts` isolates git from your own config (`GIT_CONFIG_GLOBAL`, no system config), so signing, hooks or `autocrlf` can't change results.
- Known bugs that aren't fixed yet are written as `{ todo: '...' }` tests: they run and report but don't fail the suite, and start passing when the bug is fixed.
- Pass extra flags through to `node --test`, e.g. `node scripts/test.js --test-name-pattern=rename`.

## Architecture

This is a VS Code extension that manages Claude Code CLI sessions across git repositories and worktrees.

### Core Services (`src/services/`)

- **StorageService** - Persists repositories and sessions for this machine in `state.json` under `context.globalStorageUri`, through `StateStore`. Each change takes a lock file, re-reads the file and replaces it with a rename, so windows saving at once don't lose changes; a read error throws rather than saving an empty state over the file. Don't use `globalState` for this: it is stored on the VS Code client and shared by every remote, so Coder workspaces with the same paths saw each other's sessions. It was migrated once per machine, keeping only repositories and sessions that exist there.
- **GitService** - Git operations: worktree listing/creation/deletion, branch merging, working tree status, rebase, and fetching PRs. Every call is async, uses `execFile` with an argument array (never a shell), and has a timeout. Never add a synchronous git call: in a Remote-SSH window the extension host also runs the Git extension and language servers, and blocking it freezes them all.
- **TerminalManager** - Spawns and manages VS Code terminals running `claude` CLI
- **ClaudeSessionService** - Discovers existing Claude Code sessions from `~/.claude/projects/`, copies sessions between worktrees for forking, repository-wide session search via `findSessionsForRepository()`

### Tree Providers (`src/providers/`)

- **WorkspacesTreeProvider** - Main sidebar tree: Repository → Worktree → Session hierarchy. PR badges come from `GitHubService.fetchPullRequests`: two `gh pr list` calls per repository (all open PRs, plus the newest 200 in any state), matched by branch name. Fork PRs match by branch only when the fork's owner owns one of the repository's remotes; otherwise only worktrees made by Checkout PR match them, by number
- **ChangesTreeProvider** - Shows staged/unstaged git changes for the active worktree
- **QuickActionsTreeProvider** - Quick actions panel with process tracking for run/stop functionality

### Commands (`src/commands/`)

Commands are registered in `package.json` under `contributes.commands` and implemented in:
- `repository.ts` - Add/remove/clone repositories
- `worktree.ts` - Create/delete worktrees, merge branches, open in new window, checkout PRs
- `chat.ts` - Create/open/rename/delete/fork sessions, import existing sessions, search sessions across all worktrees
- `quickActions.ts` - Run/stop quick actions (Claude prompts or shell commands)

### Data Flow

1. User adds a repository → stored in this machine's state file
2. GitService detects worktrees via `git worktree list --porcelain`
3. User creates a session → TerminalManager spawns terminal with `claude --resume <sessionId>`
4. Sessions link to Claude Code's session files for resumption

### Key Types (`src/types.ts`)

- `Repository` - Git repo with name and root path
- `Worktree` - Branch checked out in a directory
- `ChatSession` - Links to Claude Code's `claudeSessionId` for `--resume` and `--fork-session`

## Claude Code Session Discovery

Sessions are stored in `~/.claude/projects/<encoded-path>/*.jsonl` (`$CLAUDE_CONFIG_DIR/projects/` when that is set; see `claudeConfigDir()`). The `ClaudeSessionService` parses these files to extract session IDs, summaries, and timestamps for import into the extension.

- Names come from `custom-title` entries (older logs: `summary`), else the first prompt the user typed. Claude Code puts its own text in user messages, wrapped in tags such as `<system-reminder>` or `<command-name>`, and marks some entries `isMeta`. `src/utils/sessionLog.ts` removes these, and both `ClaudeSessionService` and `SessionWatcher` use it.
- Searches read only the project folders whose name starts with an encoded repository or worktree path. A machine can hold gigabytes of logs, and reading them all took minutes.

### Path Encoding

Claude Code encodes directory paths by replacing `/`, `\`, and `.` with `-`. For example:
- `/Users/dev/my-project` → `-Users-dev-my-project`

The `ClaudeSessionService.encodeProjectPath()` method handles this encoding when copying sessions between worktrees.

### Session Forking

When forking a session to a new worktree, the extension copies the entire project directory from `~/.claude/projects/<source>` to `~/.claude/projects/<dest>`. This preserves conversation history so Claude can resume from the forked point.

## Quick Actions

Quick Actions allow running Claude prompts or shell commands with one click from the sidebar.

### Two Modes

1. **Claude mode** - Uses `prompt` + `allowedTools` to run Claude headlessly:
   ```typescript
   spawn('claude', ['-p', prompt, '--allowedTools', allowedTools], { cwd: worktreePath })
   ```

2. **Command mode** - Uses `command` to run any shell command cross-platform:
   ```typescript
   spawn(command, { cwd: worktreePath, shell: true })
   ```

The `agntree.quickActions` setting is `"scope": "application"`, so it can only be set in user settings. Keep it that way: both modes run arbitrary commands, and a workspace-scoped setting would let any repository's `.vscode/settings.json` (including a PR checked out from a fork) redefine them.

Claude mode asks before running in a worktree made by Checkout PR (a recorded PR or a `pr-<n>` branch). `claude -p` shows no workspace trust prompt. It runs the hooks and MCP servers in the folder's `.claude/settings.json` and `.mcp.json`, and in a PR worktree those files come from the PR's author.

### Process Management

The `QuickActionsTreeProvider` tracks running processes in a `Map<number, ChildProcess>`. This enables:
- Displaying a spinning sync icon for running actions
- A Stop button that ends the whole process tree. `spawnProcessTree` (`src/utils/processes.ts`) starts each action in its own process group, and `killProcessTree` signals the group (`taskkill /T` on Windows). Signalling only the shell leaves `a && b`'s children running. `stopProcessTree` sends SIGKILL after 5 seconds if the action's output hasn't closed. It shows the action as stopped 2 seconds after that, even if something outside the group still holds the output open. The action shows as running until then.
- Preventing duplicate runs of the same action

### Dynamic View Titles

Both Changes and Quick Actions panels show the active worktree and repository in their titles (e.g., "Changes (feature-branch ~ my-repo)"). This is updated in `extension.ts` via the `updateViewTitles()` helper whenever the selection changes.

## Worktree Management

### Worktree Path Convention

Worktrees are created in a dedicated folder for cleaner organization:
```
/path/to/my-repo/                    # main repository
/path/to/my-repo-worktrees/          # dedicated worktrees folder
  ├── feature-login/                 # worktree for feature/login branch
  └── bugfix-header/                 # worktree for bugfix/header branch
```

### New Branch Creation

When creating a worktree with a new branch, the user selects:
1. Base branch to create the new branch from
2. New branch name
3. Worktree path (defaults to `<repo>-worktrees/<branch-name>`)

### Auto-Refresh on Branch Switch

The `WorkspacesTreeProvider` watches `.git/HEAD` and `.git/worktrees/*/HEAD` files using `vscode.RelativePattern` with absolute paths. This allows detecting branch changes even for repositories outside the current workspace, and worktrees being added or removed (including ones Claude Code creates). The tree auto-refreshes within 300ms.

### Branch vs. display name

`Worktree.name` is for display: the branch, or the folder name when HEAD is detached (for example mid-rebase). Anything that operates on a branch (delete, merge, PR lookup) must use `Worktree.branch`, which is `null` for detached worktrees. Using `name` once made "Delete Worktree & Branch" force-delete an unrelated branch that happened to share the folder's name.

Deleting a branch goes through `GitService.deleteBranch()`, which refuses an unmerged branch (reporting how many commits would be lost) unless called with `force`; the command asks before forcing.

## PR Checkout

The `agntree.checkoutPR` command creates a worktree from a GitHub pull request. It uses the `gh` CLI to list and look up PRs, and plain `git fetch` to get them.

### Flow

1. User selects a PR from a list (via `gh pr list`) or enters a PR number/URL manually (resolved with `gh pr view`)
2. The PR's URL gives the repository it was opened against; `findRemoteForPullRequest()` matches it to a local remote (https, `git@host:` and `ssh://` forms all match). If none matches, the user is asked before fetching from the repository's URL directly
3. `git fetch <remote> refs/pull/<number>/head:refs/heads/pr-<number>` creates the local branch. GitHub publishes every PR there, including PRs from forks, and nothing is checked out, so the main worktree (and any session running in it) is never touched. An existing `pr-<number>` is only fast-forwarded, never reset
4. A worktree is created from `pr-<number>`, stored in `<repo>-worktrees/<branch-name-with-hyphens>/`
5. The PR number is associated with the worktree via `storageService.setPRWorktree()`, and removed again when the worktree is deleted

### Why `pr-<number>` branch names?

Using `pr-<number>` (e.g., `pr-4267`) instead of the PR's actual branch name avoids collisions with existing local branches. The worktree directory still uses the original branch name for readability.

## Search Sessions

The `agntree.searchSessions` command finds all Claude Code sessions related to a repository across all worktrees.

### Flow

1. `ClaudeSessionService.findSessionsForRepository()` collects sessions whose `cwd` matches the repo root or any worktree path
2. Sessions are grouped by worktree using QuickPick separators
3. Already-imported sessions are marked with a checkmark and cannot be re-imported
4. Each session shows: summary, relative time, message count, branch name, and a preview of recent user prompts
5. On selection, the session is imported and assigned to the matching worktree (or main worktree if no match)

## Important VS Code Extension Gotchas

### Extension Host Restarts on Workspace Switch

Calling `vscode.workspace.updateWorkspaceFolders()` to switch to a different repository **terminates and restarts the extension host**. All in-memory state is lost. To persist state across these restarts:

1. Save anything that must survive to `StorageService` before the switch. The active worktree and chat are per window and not saved; `activate()` finds the active worktree again from the workspace folder.
2. Restore state in `activate()` after restart
3. Don't rely on in-memory maps/caches surviving

### Tree View reveal() Requirements

To use `treeView.reveal()` on nested items:

1. **Stable IDs** - Tree items must have consistent `id` properties (e.g., `this.id = \`${itemType}-${data.id}\``)
2. **getParent()** - Must implement `TreeDataProvider.getParent()` method
3. **Visibility** - Wait for tree to be visible before revealing:
   ```typescript
   if (treeView.visible) {
     treeView.reveal(item);
   } else {
     treeView.onDidChangeVisibility(e => { if (e.visible) treeView.reveal(item); });
   }
   ```

### Terminal Persistence Across Restarts

Terminals survive extension host restarts, but the mapping (sessionId → terminal) is lost. The `TerminalManager.syncWithExistingTerminals()` method re-establishes mappings by matching terminal names with the pattern `Agntree: <sessionName>`.

## Available Skills

This project includes Claude Code skills in `.claude/skills/`:

- **build-extension** - Build and package the VS Code extension
- **add-feature** - Guide for adding new features following project architecture
- **debug-extension** - Troubleshoot extension issues

Skills are auto-discovered by Claude Code when working in this project.
