# -----------------------------------------------------------------------------
# VS Code extension: Agntree for Devboxes
# -----------------------------------------------------------------------------
# Draft for coder-templates' devbox/, next to main.tf. Agntree shows the workspace's git worktrees
# and branches, including the ones Claude Code sessions make in .claude/worktrees/, in VS Code
# Desktop over Remote-SSH (venues/devops/agntree, a fork of github.com/subhashkhileri/agntree).
#
# The script unzips the VSIX that project publishes into the VS Code Server's extensions folder
# before anyone can sign in. It needs no VS Code Server: every start is a new disk, so there is no
# ~/.vscode-server yet, and the server's first scan of the extensions folder records every
# extension it finds there. Installing with the server's CLI would mean downloading the server
# (about 100 MB, from Microsoft hosts the DNS Firewall doesn't list) at every start.
#
# GITLAB_TOKEN is the package token (packages_env): the venues group deploy token, which can read
# the packages of every project in the group. Without it, or if the download fails, the workspace
# starts as usual without the extension, and the script's log says why.
#
# A new release is a change here: bump agntree_version once the project's tag pipeline has
# published it. Workspaces take it at their next start after an update.

locals {
  agntree_version = "1.3.0"
  agntree_project = "venues/devops/agntree"
  agntree_url = format(
    "https://%s/api/v4/projects/%s/packages/generic/agntree/%s/agntree-%s.vsix",
    var.gitlab_host, urlencode(local.agntree_project), local.agntree_version, local.agntree_version
  )
}

resource "coder_script" "agntree" {
  agent_id           = coder_agent.main.id
  display_name       = "VS Code extension"
  icon               = "/icon/code.svg"
  run_on_start       = true
  start_blocks_login = true
  timeout            = 120
  script             = <<-EOT
    #!/bin/bash
    set -euo pipefail
    version='${local.agntree_version}'
    extensions=/home/dev/.vscode-server/extensions
    dest="$extensions/fullhousevenues.agntree-$version"
    if [ -d "$dest" ]; then
      echo "Agntree $version: already in place"
      exit 0
    fi
    if [ -z "$${GITLAB_TOKEN:-}" ]; then
      echo "Agntree: this workspace has no package token, so VS Code won't have the extension"
      exit 0
    fi
    # Only the server's first scan records a folder the server didn't install itself
    if [ -e "$extensions/extensions.json" ]; then
      echo "Agntree: VS Code Server has already run here; install the VSIX from VS Code instead"
      exit 0
    fi
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    if ! curl -fsS --retry 3 --max-time 60 --header "DEPLOY-TOKEN: $GITLAB_TOKEN" -o "$tmp/agntree.vsix" '${local.agntree_url}'; then
      echo "Agntree: couldn't download $version from ${local.agntree_project}'s package registry"
      exit 0
    fi
    # The whole archive: some unzip builds don't let 'extension/*' match below the top folder
    if ! unzip -q "$tmp/agntree.vsix" -d "$tmp/vsix" || [ ! -f "$tmp/vsix/extension/package.json" ]; then
      echo "Agntree: the download from ${local.agntree_project} isn't a VSIX"
      exit 0
    fi
    install -d "$extensions"
    mv "$tmp/vsix/extension" "$dest"
    echo "Agntree $version: in place for VS Code over Remote-SSH"
  EOT
}
