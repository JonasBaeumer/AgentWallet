#!/usr/bin/env bash
# Trusted Payment Infrastructure for Agents — first-run setup script.
#
# Guides a fresh clone end-to-end:
#   1. Checks prerequisites (node, docker, optional stripe CLI)
#   2. Creates .env from .env.example and prompts for required values
#   3. Boots Postgres + Redis via docker compose and waits for readiness
#   4. Installs npm deps, generates Prisma client, migrates, seeds
#   5. Prints next-step instructions
#
# Flags:
#   --yes, -y        non-interactive; accept defaults, skip prompts (CI-safe)
#   --skip-seed      skip the seed step
#   -h, --help       show this help

set -euo pipefail

if [[ -t 1 ]]; then
  BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; DIM='\033[2m'; RESET='\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; BLUE=''; DIM=''; RESET=''
fi

info()    { printf "${BLUE}==>${RESET} %s\n" "$*"; }
success() { printf "${GREEN}✓${RESET}  %s\n" "$*"; }
warn()    { printf "${YELLOW}!${RESET}  %s\n" "$*"; }
error()   { printf "${RED}✗${RESET}  %s\n" "$*" >&2; }
step()    { printf "\n${BOLD}%s${RESET}\n" "$*"; }

YES=0
SKIP_SEED=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    --skip-seed) SKIP_SEED=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) error "Unknown argument: $arg"; exit 2 ;;
  esac
done

# Force non-interactive mode in CI environments even if --yes wasn't passed.
if [[ "${CI:-}" == "true" || "${CI:-}" == "1" ]]; then
  YES=1
fi

# Resolve repo root (one level up from scripts/)
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# 1. Prerequisite checks
# ---------------------------------------------------------------------------
step "1/5 Checking prerequisites"

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    error "Node.js is not installed. Install Node 20+ from https://nodejs.org"
    return 1
  fi
  local major
  major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
  if (( major < 20 )); then
    error "Node $major found — this project requires Node 20 or newer."
    return 1
  fi
  success "Node $(node -v)"
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    error "Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop"
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    error "Docker daemon is not running. Start Docker Desktop and re-run this script."
    return 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    error "'docker compose' plugin is missing. Update Docker Desktop or install the compose plugin."
    return 1
  fi
  success "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'running')"
}

check_stripe() {
  if command -v stripe >/dev/null 2>&1; then
    success "Stripe CLI $(stripe --version 2>/dev/null | awk '{print $2}')"
  else
    warn "Stripe CLI not found. Optional but recommended for local webhook forwarding."
    warn "Install: https://stripe.com/docs/stripe-cli"
  fi
}

check_platform() {
  case "$(uname -s)" in
    Darwin|Linux) ;;
    MINGW*|MSYS*|CYGWIN*)
      warn "Native Windows shells are not supported. Use WSL2 for the best experience."
      ;;
    *) warn "Untested platform: $(uname -s). Proceeding anyway." ;;
  esac
}

check_platform
check_node
check_docker
check_stripe

# ---------------------------------------------------------------------------
# 2. .env bootstrap
# ---------------------------------------------------------------------------
step "2/5 Configuring .env"

if [[ ! -f .env.example ]]; then
  error ".env.example is missing. Are you in the project root?"
  exit 1
fi

if [[ -f .env ]]; then
  success ".env already exists — leaving existing values untouched"
else
  cp .env.example .env
  success "Created .env from .env.example"

  if (( YES == 0 )); then
    prompt_value() {
      local key="$1" description="$2" default="$3" reply=""
      printf "  %s\n    ${DIM}%s${RESET}\n    [default: %s]: " "$key" "$description" "${default:-<empty>}"
      IFS= read -r reply || true
      reply="${reply:-$default}"
      # Replace or append the key=value pair (portable sed)
      if grep -q "^${key}=" .env; then
        local escaped
        escaped="$(printf '%s' "$reply" | sed -e 's/[\/&]/\\&/g')"
        sed -i.bak -e "s/^${key}=.*/${key}=${escaped}/" .env && rm -f .env.bak
      else
        printf "\n%s=%s\n" "$key" "$reply" >> .env
      fi
    }
    info "Press Enter to accept defaults. You can edit .env later."
    prompt_value STRIPE_SECRET_KEY "Stripe test-mode secret key (sk_test_...)" "sk_test_placeholder"
    prompt_value STRIPE_WEBHOOK_SECRET "Stripe webhook signing secret (whsec_...)" "whsec_placeholder"
    prompt_value TELEGRAM_BOT_TOKEN "Telegram bot token (optional)" ""
    prompt_value TELEGRAM_WEBHOOK_SECRET "Telegram webhook secret (optional)" ""
  else
    info "Non-interactive mode — keeping default placeholder values in .env"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Docker compose + readiness
# ---------------------------------------------------------------------------
step "3/5 Starting Postgres + Redis"

docker compose up -d >/dev/null
success "docker compose up -d"

POSTGRES_CONTAINER="$(docker compose ps --format '{{.Name}}' postgres | head -n1)"
REDIS_CONTAINER="$(docker compose ps --format '{{.Name}}' redis | head -n1)"

wait_for() {
  local label="$1" cmd="$2" timeout="${3:-60}"
  local elapsed=0
  while (( elapsed < timeout )); do
    if eval "$cmd" >/dev/null 2>&1; then
      success "$label is ready"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  error "$label did not become ready within ${timeout}s"
  return 1
}

wait_for "Postgres" "docker exec ${POSTGRES_CONTAINER} pg_isready -U postgres"
wait_for "Redis"    "docker exec ${REDIS_CONTAINER} redis-cli PING | grep -q PONG"

# ---------------------------------------------------------------------------
# 4. Dependencies + Prisma + seed
# ---------------------------------------------------------------------------
step "4/5 Installing dependencies and migrating database"

if [[ -d node_modules && -f package-lock.json ]]; then
  info "node_modules present — running npm install to reconcile the lockfile"
fi
npm install --no-audit --no-fund
success "npm install"

npx prisma generate >/dev/null
success "prisma generate"

npx prisma migrate deploy
success "prisma migrate deploy"

if (( SKIP_SEED == 0 )); then
  npm run seed
  success "seed"
else
  warn "Skipping seed (per --skip-seed)"
fi

# ---------------------------------------------------------------------------
# 5. Next steps
# ---------------------------------------------------------------------------
step "5/5 All set"

cat <<EOF

${GREEN}Setup complete.${RESET} Next steps:

  1. Start the dev server:
       ${BOLD}npm run dev${RESET}       # or ${BOLD}make dev${RESET}

  2. (Optional) Run the stub worker to simulate OpenClaw:
       ${BOLD}npm run worker${RESET}    # or ${BOLD}make worker${RESET}

  3. (Optional) Forward Stripe webhooks for Issuing events:
       ${BOLD}stripe listen --forward-to localhost:3000/v1/webhooks/stripe${RESET}
       Copy the printed whsec_... into .env as STRIPE_WEBHOOK_SECRET.

  4. Run the test suite:
       ${BOLD}npm test${RESET}          # fast unit tests
       ${BOLD}make test-integration${RESET}  # integration tests (uses running Postgres + Redis)

Health check:
  curl http://localhost:3000/health

EOF
