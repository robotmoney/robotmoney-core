#!/usr/bin/env bash
# scripts/runbook/upgrade-submodules.sh: fills the submodules of the separate --upgrade-build checkout ({runDir}/v060, issue 1929: the main checkout's
# out/ is never rebuilt) from the main checkout's own submodule repositories, so no library already present is fetched from the network (issue 1996).
#   bash scripts/runbook/upgrade-submodules.sh DIR [REFERENCE]
# DIR is the checkout to fill. REFERENCE is the checkout whose submodules are reused (default: the checkout this script is in).
# For each submodule of DIR, recursively: when REFERENCE/<path> is a repository that holds the commit DIR records, the submodule is cloned from that local
# repository (a local clone links its objects, no network). Otherwise it is cloned from its .gitmodules URL, with --reference REFERENCE/<path> when that is
# a repository, so only the missing objects are fetched. The local URL is a -c override for that one update: it is never written to the git config DIR
# shares with the main checkout (a linked worktree shares it).
set -euo pipefail

dir=${1:?usage: upgrade-submodules.sh DIR [REFERENCE]}
ref=${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
dir=$(cd "$dir" && pwd)
ref=$(cd "$ref" && pwd)

# Whether $1 is the top of its own repository (an uninitialised submodule directory resolves to its superproject, which is not it).
own_repo() { [ -d "$1" ] && [ "$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$1" && pwd -P)" ]; }

fill() {
  local d=$1 r=$2 line key name path sha
  [ -f "$d/.gitmodules" ] || return 0
  while IFS= read -r line; do
    key=${line%% *}; path=${line#* }
    name=${key#submodule.}; name=${name%.path}
    sha=$(git -C "$d" rev-parse "HEAD:$path")
    # init records the .gitmodules URL where none is set yet (a nested submodule's own config), so git sees the submodule as initialised
    git -C "$d" submodule --quiet init -- "$path" </dev/null
    if own_repo "$r/$path" && git -C "$r/$path" cat-file -e "$sha^{commit}" 2>/dev/null; then
      echo "submodule $path at $sha: cloned from $r/$path (no network)"
      git -C "$d" -c protocol.file.allow=always -c "submodule.$name.url=$r/$path" submodule update --init -- "$path" </dev/null
    elif own_repo "$r/$path"; then
      echo "submodule $path at $sha: not in $r/$path; fetched from its URL with --reference $r/$path"
      git -C "$d" submodule update --init --reference "$r/$path" -- "$path" </dev/null
    else
      echo "submodule $path at $sha: $r/$path is no repository; fetched from its URL"
      git -C "$d" submodule update --init -- "$path" </dev/null
    fi
    fill "$d/$path" "$r/$path"
  done < <(git -C "$d" config -f .gitmodules --get-regexp '^submodule\..*\.path$')
}

fill "$dir" "$ref"
