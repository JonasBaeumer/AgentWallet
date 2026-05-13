#!/usr/bin/env bash
set -euo pipefail

# ── AgentPay Setup ──────────────────────────────────────────────────
# Thin shell wrapper: ensures Node.js 18+ and npm are present,
# runs npm install, then hands off to the interactive TypeScript script.
# Usage: bash setup.sh [--non-interactive]
# ────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

for arg in "$@"; do
  if [ "$arg" = "--non-interactive" ]; then
    export SETUP_NON_INTERACTIVE=1
  fi
done

# ── Check Node.js ──────────────────────────────────────────────────

check_node() {
  if ! command -v node &>/dev/null; then
    echo -e "${RED}Node.js is not installed.${NC}"
    return 1
  fi

  local version
  version=$(node --version | sed 's/^v//')
  local major
  major=$(echo "$version" | cut -d. -f1)

  if [ "$major" -lt 18 ]; then
    echo -e "${RED}Node.js v${version} found — v18+ required.${NC}"
    return 1
  fi

  echo -e "${GREEN}Node.js v${version}${NC}"
  return 0
}

install_node() {
  local os_type
  os_type=$(uname -s)

  if [ "$os_type" = "Darwin" ]; then
    if command -v brew &>/dev/null; then
      echo -e "${YELLOW}Installing Node.js 20 via Homebrew...${NC}"
      brew install node@20
      return $?
    else
      echo -e "${RED}Homebrew not found. Install Node.js manually: https://nodejs.org${NC}"
      return 1
    fi
  elif [ "$os_type" = "Linux" ]; then
    if command -v apt-get &>/dev/null; then
      echo -e "${YELLOW}Installing Node.js 20 via NodeSource...${NC}"
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
      return $?
    else
      echo -e "${RED}apt-get not found. Install Node.js manually: https://nodejs.org${NC}"
      return 1
    fi
  fi

  echo -e "${RED}Unsupported OS. Install Node.js manually: https://nodejs.org${NC}"
  return 1
}

if ! check_node; then
  if [ "${SETUP_NON_INTERACTIVE:-}" = "1" ]; then
    install_node
  else
    read -rp "Install Node.js 20? [y/N] " yn
    case "$yn" in
      [Yy]*) install_node ;;
      *) echo "Aborting — Node.js 18+ is required."; exit 1 ;;
    esac
  fi

  if ! check_node; then
    echo -e "${RED}Node.js installation failed. Please install manually: https://nodejs.org${NC}"
    exit 1
  fi
fi

# ── Check npm ──────────────────────────────────────────────────────

if ! command -v npm &>/dev/null; then
  echo -e "${RED}npm is not installed. It should come with Node.js.${NC}"
  exit 1
fi
echo -e "${GREEN}npm $(npm --version)${NC}"

# ── Install dependencies ───────────────────────────────────────────

echo ""
echo -e "${YELLOW}Installing dependencies...${NC}"
npm install --no-audit --no-fund
echo ""

# ── Hand off to TypeScript ─────────────────────────────────────────

exec npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/setup.ts "$@"
