#!/usr/bin/env sh
# One command to set the worker up on Linux, WSL or macOS: sh install.sh
# It installs uv (a small Python installer) for this user if it is missing, then the worker and what it needs.
set -e
cd "$(dirname "$0")"
if ! command -v uv >/dev/null 2>&1; then
  if [ -x "$HOME/.local/bin/uv" ]; then PATH="$HOME/.local/bin:$PATH"; else
    echo "Installing uv for this user."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    PATH="$HOME/.local/bin:$PATH"
  fi
fi
EXTRA="${1:-gpu}"
uv venv --python 3.12 --allow-existing .venv
uv pip install --python .venv -e ".[$EXTRA]"
[ -f worker.toml ] || cp worker.example.toml worker.toml
echo
echo "Done. Put your site address and token in worker.toml, then run: sh run.sh check"
