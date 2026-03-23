FROM node:20-alpine

# Install Playwright dependencies (lightweight)
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    bash \
    curl \
    wget \
    jq \
    git \
    python3 \
    py3-pip \
    py3-requests \
    make \
    g++

# Tell Playwright where to find the local chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Create persistent storage directories
RUN mkdir -p /app/config /app/config/whatsapp-auth /app/skills /mnt/safe

# Expose internal API port for the host CLI
EXPOSE 6192

CMD ["node", "index.js"]
