#!/usr/bin/env bash
# check-billing.sh — Run billing cycle from cron.
# Wraps scripts/run-billing.js with proper environment setup.
#
# Usage: bash scripts/check-billing.sh [--dry-run] [--status]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

cd "$REPO_DIR"
node scripts/run-billing.js "${@}"
