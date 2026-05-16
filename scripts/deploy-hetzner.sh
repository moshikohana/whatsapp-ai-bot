#!/usr/bin/env bash
# WhatsApp AI Bot — Hetzner Cloud one-shot deploy script.
# Tested on: Ubuntu 24.04 LTS, CX22 (4GB RAM, 2 vCPU).
#
# Usage (on the server):
#   curl -fsSL https://raw.githubusercontent.com/moshikohana/whatsapp-ai-bot/master/scripts/deploy-hetzner.sh | bash
#
# What it does:
#   1. Installs system deps (Node 20, Chromium libs, git, nano, pm2)
#   2. Clones the bot repo to /opt/whatsapp-ai-bot
#   3. Runs npm install
#   4. Opens nano so you can paste your .env (right-click → paste)
#   5. Starts the bot with pm2 and configures auto-restart on boot
#   6. Prints the URL where you scan WhatsApp QR
#
# Idempotent — safe to re-run.

set -e

BOLD='\033[1m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
CYAN='\033[1;36m'
NC='\033[0m'

INSTALL_DIR="/opt/whatsapp-ai-bot"
REPO_URL="https://github.com/moshikohana/whatsapp-ai-bot.git"

echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}WhatsApp AI Bot — Hetzner Deploy${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
echo ""

# ── 1. System packages ─────────────────────────────────────────
echo -e "${YELLOW}[1/6] Updating system + installing dependencies (~3 min)...${NC}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  curl wget git build-essential ca-certificates gnupg nano \
  fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 \
  libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
  libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
  libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 \
  libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
  libxi6 libxkbcommon0 libxrandr2 libxrender1 libxss1 libxtst6 \
  lsb-release xdg-utils

# ── 2. Node.js 20 LTS ──────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -v | cut -c2-3)" != "20" ]]; then
  echo -e "${YELLOW}[2/6] Installing Node.js 20 LTS...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo -e "${GREEN}[2/6] Node.js 20 already installed ($(node -v))${NC}"
fi

# ── 3. pm2 ─────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  echo -e "${YELLOW}[3/6] Installing pm2 (process manager)...${NC}"
  npm install -g pm2
else
  echo -e "${GREEN}[3/6] pm2 already installed${NC}"
fi

# ── 4. Clone / update repo ─────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo -e "${YELLOW}[4/6] Updating existing repo...${NC}"
  cd "$INSTALL_DIR"
  git fetch --all
  git reset --hard origin/master
else
  echo -e "${YELLOW}[4/6] Cloning repo to $INSTALL_DIR...${NC}"
  rm -rf "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ── 5. npm install ─────────────────────────────────────────────
echo -e "${YELLOW}[5/6] Installing npm dependencies (~3-5 min, downloads Chromium for Puppeteer)...${NC}"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -20

# ── 6. .env setup ──────────────────────────────────────────────
if [[ -f "$INSTALL_DIR/.env" ]] && grep -q "ANTHROPIC_API_KEY=sk-" "$INSTALL_DIR/.env" 2>/dev/null; then
  echo -e "${GREEN}[6/6] .env already exists with API keys — keeping it${NC}"
else
  echo ""
  echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}📋 PASTE YOUR .env NOW${NC}"
  echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "${YELLOW}On your local PC:${NC}"
  echo "  1. Open the file:  C:\\Users\\moshi\\OneDrive\\שולחן העבודה\\whatsapp-ai-bot\\.env"
  echo "  2. Select all (Ctrl+A) → Copy (Ctrl+C)"
  echo ""
  echo -e "${YELLOW}Here in this console:${NC}"
  echo "  3. After pressing Enter, nano will open."
  echo "  4. Right-click in the console → Paste."
  echo "  5. Save & exit: press Ctrl+O → Enter → Ctrl+X"
  echo ""
  read -p "Press Enter to open nano..." -r
  nano "$INSTALL_DIR/.env"
fi

# ── 7. Start with pm2 ──────────────────────────────────────────
cd "$INSTALL_DIR"
echo ""
echo -e "${YELLOW}Starting bot with pm2...${NC}"
pm2 delete whatsapp-bot 2>/dev/null || true
pm2 start index.js --name whatsapp-bot --max-memory-restart 1500M
pm2 save

# ── 8. Auto-start on boot ──────────────────────────────────────
echo -e "${YELLOW}Setting up auto-restart on server reboot...${NC}"
STARTUP_CMD=$(pm2 startup systemd -u root --hp /root | tail -1)
if [[ "$STARTUP_CMD" == *"sudo"* ]] || [[ "$STARTUP_CMD" == *"systemctl"* ]]; then
  eval "$STARTUP_CMD"
fi

# ── 9. Verify firewall ─────────────────────────────────────────
if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo -e "${YELLOW}UFW firewall is active — opening port 3000 for QR scan...${NC}"
  ufw allow 3000/tcp || true
fi

# ── 10. Wait for bot to boot, then announce ────────────────────
echo ""
echo -e "${CYAN}Waiting 15s for bot to print QR...${NC}"
sleep 15

PUBLIC_IP=$(curl -s ifconfig.me || hostname -I | awk '{print $1}')
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}🎉 Setup complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo ""
echo -e "  ${YELLOW}1.${NC} Open this URL in your browser to scan WhatsApp QR:"
echo -e "     ${CYAN}http://${PUBLIC_IP}:3000${NC}"
echo ""
echo -e "  ${YELLOW}2.${NC} On your phone: WhatsApp → ⋮ → Linked Devices → Link Device"
echo ""
echo -e "  ${YELLOW}3.${NC} Scan the QR code shown on the web page"
echo ""
echo -e "${BOLD}Useful commands:${NC}"
echo "  pm2 status            — see if bot is running"
echo "  pm2 logs whatsapp-bot — view live logs"
echo "  pm2 restart whatsapp-bot — restart the bot"
echo "  pm2 stop whatsapp-bot — stop the bot"
echo ""
pm2 status
