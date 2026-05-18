#!/usr/bin/env bash
# Family Bot — deploy alongside the main bot on the SAME Hetzner Cloud server.
# Runs on port 3001, isolated from the main bot on port 3000.
#
# Prerequisite: main bot already deployed via scripts/deploy-hetzner.sh
# (this script assumes /opt/whatsapp-ai-bot/ exists with Node, pm2, deps).
#
# Usage (on the server):
#   cd /opt/whatsapp-ai-bot
#   git pull
#   bash scripts/deploy-family-bot.sh
#
# What it does:
#   1. Verifies main bot deployment exists
#   2. cd to family-bot/ subdir, runs npm install
#   3. Starts the family-bot service with pm2 on port 3001
#   4. Configures auto-restart on server reboot
#   5. Opens firewall port 3001 if UFW is active
#   6. Prints the admin URL (localhost:3001/) for the admin to access
#
# Idempotent — safe to re-run.

set -e

BOLD='\033[1m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
CYAN='\033[1;36m'
NC='\033[0m'

MAIN_DIR="/opt/whatsapp-ai-bot"
FAMILY_DIR="$MAIN_DIR/family-bot"

echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}Family Bot — Hetzner Deploy (alongside main bot)${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
echo ""

# ── 1. Pre-flight ──────────────────────────────────────────────
if [[ ! -d "$MAIN_DIR" ]]; then
  echo -e "${RED}❌ Main bot not deployed. Run scripts/deploy-hetzner.sh first.${NC}"
  exit 1
fi
if ! command -v node &>/dev/null; then
  echo -e "${RED}❌ Node.js not installed. Main bot deploy should have done this.${NC}"
  exit 1
fi
if ! command -v pm2 &>/dev/null; then
  echo -e "${RED}❌ pm2 not installed. Main bot deploy should have done this.${NC}"
  exit 1
fi

# ── 2. Update repo + cd into family-bot ────────────────────────
echo -e "${YELLOW}[1/5] Pulling latest changes...${NC}"
cd "$MAIN_DIR"
git fetch --all
git reset --hard origin/master

if [[ ! -d "$FAMILY_DIR" ]]; then
  echo -e "${RED}❌ family-bot directory missing — repo update failed?${NC}"
  exit 1
fi

cd "$FAMILY_DIR"
echo -e "${GREEN}    Repo updated. family-bot dir present.${NC}"

# ── 3. npm install ─────────────────────────────────────────────
echo -e "${YELLOW}[2/5] Installing dependencies (~2 min)...${NC}"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -10

# ── 4. Ensure data + logs dirs ─────────────────────────────────
mkdir -p "$FAMILY_DIR/data/tenants"
mkdir -p "$FAMILY_DIR/logs"

# ── 5. .env setup (optional — shared secrets fall back to main bot's .env) ──
if [[ ! -f "$FAMILY_DIR/.env" ]]; then
  echo -e "${YELLOW}[3/5] No family-bot .env — that's fine, shared secrets come from main bot's .env.${NC}"
  # Create a stub so dotenv doesn't warn
  cat > "$FAMILY_DIR/.env" << 'EOF'
# Family Bot configuration.
# Shared secrets (Anthropic, Groq, Google OAuth app, Telegram app) are pulled
# from ../whatsapp-ai-bot/.env automatically (selectively — NO admin tokens
# leak through; see server.js for the SAFE_TO_SHARE list).
#
# Optional overrides:
# FAMILY_BOT_PORT=3001
# FAMILY_BOT_PUBLIC_HOST=https://your-domain.com   # for OAuth callbacks via tunnel
# FAMILY_BOT_ADMIN_TOKEN=                          # optional remote admin access
EOF
  echo -e "${GREEN}    Created stub .env (with comments).${NC}"
else
  echo -e "${GREEN}[3/5] .env already exists — keeping it${NC}"
fi

# ── 6. Start with pm2 ──────────────────────────────────────────
echo -e "${YELLOW}[4/5] Starting family-bot under pm2 on port 3001...${NC}"
pm2 delete family-bot 2>/dev/null || true
pm2 start "$FAMILY_DIR/server.js" --name family-bot --max-memory-restart 2000M
pm2 save

# pm2 startup was set up by main deploy; just save current process list

# ── 7. Firewall ────────────────────────────────────────────────
if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo -e "${YELLOW}    UFW active — allowing port 3001...${NC}"
  ufw allow 3001/tcp || true
fi

# ── 8. Wait + announce ─────────────────────────────────────────
echo -e "${CYAN}[5/5] Waiting 5s for server to boot...${NC}"
sleep 5

PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}🎉 Family Bot deployed!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BOLD}Admin dashboard:${NC}"
echo -e "  ${CYAN}http://${PUBLIC_IP}:3001/${NC}"
echo ""
echo -e "${BOLD}Add a tenant (e.g. brother, mom):${NC}"
echo -e "  1. Open the admin URL above"
echo -e "  2. Enter their phone number (e.g. +9725...)"
echo -e "  3. Click 'Create Code'"
echo -e "  4. The pairing code (8 chars) appears next to their entry"
echo -e "  5. Send the code to them via WhatsApp"
echo -e "  6. On their phone: WhatsApp → ⋮ → Linked Devices → Link with phone number"
echo -e "  7. Enter the code — done!"
echo ""
echo -e "${BOLD}Useful commands:${NC}"
echo "  pm2 status                  — see all running bots (main + family)"
echo "  pm2 logs family-bot         — view live family-bot logs"
echo "  pm2 restart family-bot      — restart family-bot"
echo "  pm2 stop family-bot         — stop family-bot"
echo ""
pm2 status
