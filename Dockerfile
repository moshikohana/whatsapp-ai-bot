FROM node:20-slim

# Install Chromium + FFmpeg + fonts + face-api native deps
RUN apt-get update && apt-get install -y \
  chromium \
  ffmpeg \
  fonts-noto \
  fonts-noto-color-emoji \
  dumb-init \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Puppeteer: skip bundled Chromium, use system one
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source
COPY . .

# Bake seed copies of mutable data files so start.sh can initialize
# a fresh Railway volume on first boot without losing config.
RUN mkdir -p /app/data-seed \
  && (cp data/daily.json /app/data-seed/ 2>/dev/null || echo '[]' > /app/data-seed/daily.json) \
  && (cp photo-filter-config.json /app/data-seed/ 2>/dev/null || echo '{"threshold":0.43,"people":{}}' > /app/data-seed/photo-filter-config.json) \
  && echo '[]' > /app/data-seed/scheduled.json \
  && echo '{}' > /app/data-seed/conversations.json \
  && echo '[]' > /app/data-seed/bot-memory.json \
  && echo '{"lastTopics":[]}' > /app/data-seed/bot-context.json

# Create runtime dirs (Railway volumes will mount here)
RUN mkdir -p data .wwebjs_auth

# Make startup script executable
RUN chmod +x start.sh

EXPOSE 3000

# dumb-init handles signals properly (graceful shutdown, zombie reaping)
CMD ["sh", "start.sh"]
