#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo "op-agent requires Node.js 22 or newer. Install Node.js, then run this installer again." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found. Install Node.js with npm, then run this installer again." >&2
  exit 1
fi

source=${OP_AGENT_SOURCE:-https://github.com/itegramin/op-agent/archive/refs/heads/main.tar.gz}
prefix=${OP_AGENT_INSTALL_DIR:-"$HOME/.local"}
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
archive="$tmp_dir/source.tar.gz"
package_dir="$tmp_dir/package"
mkdir -p "$package_dir"

if [[ "$source" == http://* || "$source" == https://* ]]; then
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$source" -o "$archive"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$source" -O "$archive"
  else
    echo "curl or wget is required to download op-agent." >&2
    exit 1
  fi
else
  if [[ ! -f "$source" ]]; then
    echo "OP_AGENT_SOURCE is not a file or HTTP(S) URL: $source" >&2
    exit 1
  fi
  cp "$source" "$archive"
fi

tar -xzf "$archive" --strip-components=1 -C "$package_dir"
if [[ ! -f "$package_dir/package.json" ]]; then
  echo "The source archive does not contain an op-agent package.json." >&2
  exit 1
fi

npm pack --pack-destination "$tmp_dir" "$package_dir" >/dev/null
packed_archive=$(find "$tmp_dir" -maxdepth 1 -type f -name '*.tgz' -print -quit)
if [[ -z "$packed_archive" ]]; then
  echo "npm did not create an installable package archive." >&2
  exit 1
fi

npm install --global --prefix "$prefix" --ignore-scripts "$packed_archive"
echo "Installed op-agent to $prefix/bin/op-agent"
case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *) echo "Add this directory to your PATH: $prefix/bin" ;;
esac
