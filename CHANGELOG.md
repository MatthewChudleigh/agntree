# Changelog

All notable changes to Agntree will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Saved data is now per machine** — Repositories and sessions were kept in VS Code's `globalState`, which lives on your local VS Code and is shared by every machine it connects to. Over Remote-SSH (including Coder), two workspaces with the same paths showed each other's sessions, and removing a "missing" session in one removed it from the other; windows could also overwrite each other's lists. They are now kept in a file on the machine itself (the extension's global storage folder; on a remote, under `~/.vscode-server`), which windows on that machine lock while saving so none of their changes are lost. On first start each machine copies over its own repositories and sessions — those whose folders and Claude Code logs exist there.

### Fixed

- **Delete Worktree could delete a folder git refused to remove** — When git didn't recognize a worktree (for example its `.git` had been replaced by a repository of its own), the folder was deleted recursively, without checking for uncommitted changes. Now only git deletes worktrees; if it refuses, nothing is deleted and the reason is shown. A worktree whose folder is already gone is pruned.
- **Search and Import Sessions read every session log on the machine** — Finding a repository's sessions parsed all of `~/.claude/projects` first (2 minutes for 3.3 GB of logs), and each preview re-scanned every project folder synchronously. Only the folders named after the repository's paths are read now, and previews read the file already found. Sessions started in a subfolder are now found on Windows too.
- **Session names were often Claude Code's own text** — Names came from `summary` entries, which current Claude Code doesn't write, or from the first user message, which often starts with a `<system-reminder>` block or a slash-command wrapper. Names now come from Claude Code's session title (`custom-title`), else the first thing you typed (slash commands show as `/name args`). New sessions pick up the title once Claude Code records it. Previews skip system text and tool results.
- **`CLAUDE_CONFIG_DIR` was ignored** — Sessions were always looked for in `~/.claude`, so with Claude Code's config folder moved elsewhere none were found.
- **PR badges never showed merged or closed PRs** — `gh pr list` returns only open PRs unless asked, so a branch whose PR was merged looked like it had none, and a fork's PR could be shown on a local branch that happened to share its name (such as `main`). PRs in every state now show, from two `gh` calls per repository (all open PRs, and the newest 200 in any state) instead of one per worktree. Fork PRs match a branch only when the fork is yours (its owner owns one of the repository's remotes), and worktrees made by Checkout PR now show their PR's state and can open it in the browser.
- **All Files → Delete always failed over Remote-SSH** — It asked VS Code for the trash, which remote windows don't have. In a remote window it now asks to delete permanently; locally it offers that if the trash fails. Reveal in Finder is hidden in remote windows, where it did nothing.
- **Stopping a quick action left its processes running** — On Linux and macOS, Stop signalled only the shell, so the commands it started (for `npm test && npm run lint`, npm and its children) kept running while the panel showed the action as stopped and allowed starting it again. Stop now ends the whole process tree, force-killing it after 5 seconds, and the action shows as running until it has finished (or 2 seconds after the force-kill at most). Output now appears in the output channel as it is produced instead of when the action ends.

- **Delete Worktree & Branch could delete the wrong branch** — For a detached worktree (for example mid-rebase) the folder name was used as the branch name, so an unrelated branch with that name was force-deleted. Worktrees now track their real branch, detached ones offer no branch deletion, and a branch with unmerged commits is only deleted after a second confirmation that says how many commits would be lost.
- **New File emptied existing files** — Typing an existing name into All Files → New File overwrote that file with nothing. New File, New Folder and Rename now refuse names that already exist or point outside the worktree, and say so as you type.
- **Merge conflicts reported as a generic failure** — The worktree was left mid-merge with only "Failed to merge". The message now lists the conflicted files and offers to open a terminal or abort the merge.
- **PR checkout switched the main checkout's branch** — It ran `gh pr checkout` in the main worktree and switched back, so anything running there briefly saw the PR's files. PRs are now fetched from `refs/pull/<n>/head` without checking anything out.
- **Git calls froze the extension host** — Every git command ran synchronously with no timeout, and the Changes panel started one extra git process per changed file. Git now runs asynchronously with timeouts; the Changes panel uses three git calls however many files changed; fetch and clone can be cancelled; and rebase/merge never wait for an editor, even with `GIT_EDITOR` set.
- **Changes panel showed renamed and non-ASCII files wrongly** — Renames appeared as deleted files with a `{a => b}` path, and non-ASCII names came back escaped so they couldn't be staged. Renames now show once with their old path, and unresolved conflicts get their own `!` status.
- **Settings and shortcuts changed without asking** — Opening a diff permanently set `diffEditor.renderSideBySide` to `false` and locked the editor group; diffs now follow your own settings. `Ctrl+Shift+S` / `Cmd+Shift+S` (Starred Sessions) took over Save As everywhere; it now applies only while the Workspaces view is focused.
- Bare repositories no longer appear as a worktree, `origin` is no longer listed as a branch, removed worktrees disappear from the tree without a manual refresh, and a deleted PR worktree's badge no longer reappears on a new worktree at the same path.

### Security

- **Claude quick actions ask before running in a PR's worktree** — Claude-mode quick actions run `claude -p`, which shows no workspace trust prompt and runs the hooks and MCP servers in the folder's `.claude/settings.json` and `.mcp.json`. In a worktree made by Checkout PR those files come from the PR's author, so running the default "Commit" action there could run their code. Claude quick actions now ask for confirmation in those worktrees.
- **Quick actions can only be defined in user settings** — `agntree.quickActions` runs shell commands and headless Claude prompts, but could be set by any repository's `.vscode/settings.json` (including a PR checked out from a fork). It is now `application`-scoped. Move any quick actions you defined in workspace settings to your user settings.

### Added

- Unit tests (`npm test`) for git operations, session discovery and path handling, run against real temporary git repositories with Node's built-in test runner.

## [1.2.1] - 2026-05-17

### Added

- **Search in Files** — New search button in the All Files panel toolbar. Opens VS Code's native Search panel pre-scoped to the active worktree directory, so results are limited to that branch's files.
- **Focus on Startup** — New `agntree.focusOnStartup` setting (default `false`). When enabled, Agntree automatically focuses its sidebar panel when VS Code starts instead of the File Explorer. Toggle directly from the Workspaces panel toolbar via the eye icon.
- **Panel size defaults** — Initial panel proportions are now set so Workspaces gets the most space (4), All Files next (3), Changes after that (2), and Quick Actions the least (1).
- **Quick Actions collapsed by default** — The Quick Actions panel now starts collapsed on first install for a cleaner initial layout.

## [1.2.0] - 2026-05-16

### Added

- **Star Sessions** — Mark important sessions with a star for quick access and visual distinction in the sidebar.
- **Discard All Changes** — One-click discard of all unstaged changes from the Changes panel, with confirmation dialog.
- **Rebase onto Upstream** — Rebase the current branch onto upstream (or origin) with a pre-flight conflict check that warns before proceeding.

### Fixed

- **Discard destroying staged changes** — Discard file and discard all used `git checkout HEAD --` which reset to HEAD, wiping staged changes. Now uses `git checkout --` to restore from the index, preserving staged changes.
- **Staged new files shown as Modified** — Newly staged files (not yet committed) incorrectly showed status `M` instead of `A` because `git ls-files` considers staged files as tracked. Now checks against `HEAD` with `git cat-file` for staged changes.
- **Session auto-rename race condition** — `fs.watch` could miss the initial session file write, causing auto-rename to fail silently. Added a fallback directory scan to reliably detect new sessions.
- **Memory leaks and excessive refreshes** — Fixed leaked file watchers, added refresh coalescing to batch rapid tree updates, and ensured child processes are cleaned up on extension deactivation.
- **Auto-rename polling reliability** — Improved polling logic for session auto-rename to handle edge cases where the session file is not immediately available.

## [1.1.0] - 2026-02-24

### Added

- **Search Sessions** — Repository-level command to find and import all Claude Code sessions across all worktrees. Sessions are grouped by worktree with previews of recent prompts, message counts, and relative timestamps. Already-imported sessions are marked and excluded from re-import.
- **PR Checkout** — Check out any GitHub pull request into a new worktree. Uses `gh` CLI for remote resolution, supporting PRs from both same-repo branches and forks. Local branches are named `pr-<number>` to avoid collisions.

### Fixed

- **PR checkout failing with "invalid reference"** — Previously used `git fetch origin <branchName>` which failed for PRs from forks or when the branch didn't exist on `origin`. Now uses `gh pr checkout` which handles remote resolution automatically.
- **PR checkout ignoring fetch failures** — The return value of `fetchBranch()` was not checked, causing `createWorktree()` to proceed with a non-existent branch reference. Now aborts early with a clear error message on fetch failure.

## [1.0.0] - 2026-02-16

### Added

- **GitHub Pages landing site** — `docs/index.html` with SEO meta tags, Open Graph, Twitter Card, and JSON-LD structured data (SoftwareApplication + FAQPage)
- **Sitemap and robots.txt** — For Google Search Console indexing
- **CONTRIBUTING.md** — Full contribution guide with "Adding Support for New AI Coding Agents" section
- **CHANGELOG.md** — Version history in Keep a Changelog format
- **SECURITY.md** — Data privacy notes and vulnerability reporting policy
- **CODE_OF_CONDUCT.md** — Contributor Covenant v2.1
- **GitHub issue templates** — Bug report, feature request, and new agent support request (YAML forms with agent/IDE dropdowns)
- **Pull request template** — Checklist for code quality and testing
- **Release workflow update** — Keyword-rich release body with Marketplace install link

## [0.1.0] - 2025-01-01

### Added

- **AI Agent Session Management** — Create, resume, rename, and remove Claude Code sessions from the sidebar
- **Git Worktree Integration** — Automatically detect and manage git worktrees for each repository
- **Session Forking** — Fork sessions within the same worktree or to a new worktree with uncommitted changes
- **Session Import** — Import existing Claude Code sessions from `~/.claude/projects/` with multi-select support
- **Changes Panel** — View staged/unstaged changes with inline diffs, stage/unstage/discard actions
- **Quick Actions** — Run Claude prompts or shell commands with one click (configurable)
- **Multi-Repository Management** — Add and organize multiple git repositories in one sidebar
- **Clone from GitHub** — Clone repositories directly from GitHub URLs or shorthand notation
- **Auto-Naming** — Sessions are automatically named based on their first prompt or summary
- **Workspace Switching** — Optionally switch VS Code workspace folder when selecting a worktree
- **State Persistence** — Active worktree and session selection persists across VS Code restarts
- **Session Previews** — Hover over sessions to see the last 3 messages in a tooltip
- **Terminal Sync** — Switching between terminal tabs auto-selects the corresponding session
- **Worktree Merge** — Merge branches between worktrees directly from the extension
- **Dynamic View Titles** — Changes and Quick Actions panels show active worktree and repository name
- **Open PR in Browser** — Open the pull request for a worktree's branch directly in the browser
