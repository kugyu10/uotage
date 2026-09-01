#!/usr/bin/env zsh
set -euo pipefail

bundle_root=${0:A:h}
source_dir="$bundle_root/saas-auth-probe"
if [[ ${1:-} == "--target-root" && -n ${2:-} ]]; then
  codex_root=$2
elif [[ $# -eq 0 ]]; then
  codex_root="${CODEX_HOME:-$HOME/.codex}"
else
  print -u2 "usage: zsh install-global-skill.sh [--target-root <codex-root>]"
  exit 2
fi
target_dir="$codex_root/skills/saas-auth-probe"

if [[ ! -f "$source_dir/SKILL.md" ]]; then
  print -u2 "saas-auth-probe: skill bundle is incomplete: $source_dir"
  exit 1
fi

mkdir -p "$codex_root/skills"
if [[ -e "$target_dir" ]]; then
  backup_dir="${target_dir}.backup-$(date +%Y%m%d%H%M%S)"
  mv "$target_dir" "$backup_dir"
  print "previous skill backed up: $backup_dir"
fi

mkdir -p "$target_dir"
cp -R "$source_dir/." "$target_dir/"
print "saas-auth-probe installed: $target_dir"
print "Restart Codex or start a new session to load \$saas-auth-probe."
