FROM node:20-slim

# Install Chromium + FFmpeg + fonts for WhatsApp rendering
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

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy app source
COPY . .

# Create persistent dirs
RUN mkdir -p data .wwebjs_auth

# Non-root user for security (Chromium needs --no-sandbox with root, but we set that)
EXPOSE 3000

# dumb-init handles signals properly (graceful shutdown)
CMD ["dumb-init", "node", "index.js"]
