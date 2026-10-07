#!/usr/bin/env bash
set -euo pipefail
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo 'Install Node.js 22 or later (includes npm) from https://nodejs.org, then rerun this script.' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or later is required."); process.exit(1); }'
install_dir="${OP_AGENT_INSTALL_DIR:-$HOME/.local}"
source_package="${OP_AGENT_SOURCE:-https://github.com/itegramin/op-agent/archive/refs/heads/main.tar.gz}"
npm install --global --prefix "$install_dir" --ignore-scripts --no-audit --no-fund "$source_package"
"$install_dir/bin/op-agent" --version
echo "Installed op-agent to $install_dir/bin/op-agent"
case ":$PATH:" in
  *":$install_dir/bin:"*) ;;
  *) echo "Add $install_dir/bin to your shell PATH, then open a new terminal." ;;
esac
cat <<'EOF'

Next steps:
1. Create an API key at https://console.anthropic.com/
2. Set it in your terminal: export ANTHROPIC_API_KEY='your-key'
3. Open your project: cd /path/to/your-project
4. Start op-agent: op-agent

To use OpenAI instead, set OPENAI_API_KEY and OP_AGENT_PROVIDER=openai.
EOF
