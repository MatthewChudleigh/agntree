# Agntree on devboxes

How this fork reaches VS Code on the Coder devboxes, and what to check the first time.
The extension is **Agntree for Devboxes**, ID `fullhousevenues.agntree`.

## Why the ID changed

Upstream Agntree is on the VS Code Marketplace as `subhashkhileri.agntree`.
With the same ID, VS Code treats the fork as that extension.
"Install in SSH", `remote.SSH.defaultExtensions` and updates would all fetch the Marketplace version over the fork.

- Uninstall the Marketplace Agntree wherever this one is used. Both register the same commands and views.
- Saved repositories and sessions move with the rename.
  On first start, the extension copies `state.json` from the old ID's storage folder, `globalStorage/subhashkhileri.agntree/`, if it has none of its own.

## Publishing

The fork's source is on GitHub (`MatthewChudleigh/agntree`).
The devboxes fetch the VSIX from the internal GitLab, because their package token already reads it.

1. Create the project `venues/devops/agntree` and push this repository to it (`git remote add gitlab …`, then `git push gitlab main --tags`).
2. Protect `v*` tags (Settings → Repository → Protected tags), so that only Maintainers can publish.
3. To release:
   - Bump `version` in `package.json` and add a `CHANGELOG.md` section, through a merge request.
   - After the merge, push the tag `v<version>`.

   The tag pipeline (`.gitlab-ci.yml`) builds, tests and uploads `agntree/<version>/agntree-<version>.vsix` to the project's generic package registry. A version is uploaded once; the job refuses to replace it.

Every other pipeline builds and tests too, and keeps the VSIX as an artifact for a week, for trying a branch by hand.

## Installing on devboxes

`agntree.tf` is a draft for coder-templates' `devbox/`, next to `main.tf`.
It passes `tofu fmt` and `tofu validate` against the template as of `ce90de2`.

At each start, a blocking `coder_script` downloads the pinned version with the package token (`GITLAB_TOKEN`). It unzips the extension into `~/.vscode-server/extensions/fullhousevenues.agntree-<version>/` before anyone can sign in.
VS Code Server records it on its first scan of that folder. That scan happens because every start is a new disk with no `~/.vscode-server` yet.
Nothing has to download VS Code Server for this.

To roll out a release, bump `agntree_version` in `agntree.tf` through a coder-templates merge request.
Workspaces take it at their next start after an update.

## Connecting with VS Code

A draft for the user guide's **Connect** section:

> ### VS Code
>
> Install **Remote - SSH** (`ms-vscode-remote.remote-ssh`), then run **Remote-SSH: Connect to Host…** and pick `coder.<workspace>` (from `coder config-ssh`).
> Open the folder `/home/dev/work/<repo>`.
> Agntree is already installed on the workspace, and adds the repository by itself.
> Its **Workspaces** view lists the checkout and each Claude worktree in `.claude/worktrees/`, with its branch.
>
> Close the window when you finish: like a Desktop connection, an open VS Code connection keeps the workspace running.

Before the DNS Firewall moves to BLOCK, choose how the workspace gets VS Code Server:

- **Laptop download:** set `"remote.SSH.localServerDownload": "always"` in each developer's VS Code user settings. The laptop downloads the server and copies it over SSH, which costs about 100 MB at each workspace start, since the disk is new.
- **Workspace download:** allow `update.code.visualstudio.com` and the host it redirects to. While the firewall is in ALERT, the `/devbox/dns-queries` log shows which names a connection looks up.

## Check on the first workspace

These were tested on Windows with VS Code 1.143 and on Linux unit tests, not yet on a devbox:

- **The download authenticates.** `curl` sends the deploy token as `DEPLOY-TOKEN`. If the script logs a 401, use basic auth with the token's username instead (`--user "<username>:$GITLAB_TOKEN"`, with the username from `packages_login`).
- **The server picks up the folder.** After connecting, the Extensions view should show "Agntree for Devboxes" under SSH: coder.<workspace>, and `~/.vscode-server/extensions/extensions.json` should list it.
- **Insiders.** VS Code Insiders uses `~/.vscode-server-insiders/`, which the script doesn't fill.

## What it doesn't do yet

- **Sessions Claude Desktop starts aren't listed** until you import them (**Search Sessions**). The worktrees they create are listed.
- **PR badges and Checkout PR need GitHub's `gh` CLI**, so they show nothing for GitLab merge requests.
- **Nothing it saves survives a stop**, because the disk goes with it. Each start begins with the checkout added again and no saved sessions.
