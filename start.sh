#!/bin/sh
# ─────────────────────────────────────────────────────────────────
# Startup script — runs before node index.js
# Seeds persistent-volume directories with defaults from the image.
# Safe to run multiple times (never overwrites existing data).
# ─────────────────────────────────────────────────────────────────

set -e

echo "🚀 Starting whatsapp-ai-bot..."

# Ensure directories exist (Railway volumes replace these at mount time)
mkdir -p /app/.wwebjs_auth /app/data

# Seed data files if missing (volume starts empty on first deploy)
seed() {
  dest="$1"
  src="$2"
  default="$3"
  if [ ! -f "$dest" ]; then
    if [ -f "$src" ]; then
      cp "$src" "$dest"
      echo "📋 Seeded $dest from image"
    else
      echo "$default" > "$dest"
      echo "📋 Created $dest with default"
    fi
  fi
}

seed /app/data/daily.json            /app/data-seed/daily.json            '[]'
seed /app/data/scheduled.json        /app/data-seed/scheduled.json        '[]'
seed /app/data/conversations.json    /app/data-seed/conversations.json    '{}'
seed /app/photo-filter-config.json   /app/data-seed/photo-filter-config.json  '{"threshold":0.43,"people":{}}'
seed /app/bot-memory.json            /app/data-seed/bot-memory.json       '[]'
seed /app/bot-context.json           /app/data-seed/bot-context.json      '{"lastTopics":[]}'

echo "✅ Data seeded — launching bot"
exec dumb-init node index.js
