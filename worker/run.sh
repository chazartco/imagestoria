#!/usr/bin/env sh
# Start the worker: sh run.sh        Check the setup: sh run.sh check
cd "$(dirname "$0")"
exec .venv/bin/python -m afterimage_worker "$@"
