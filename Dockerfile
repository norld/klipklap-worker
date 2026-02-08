# Use Node.js runtime
FROM node:18-alpine

# Install yt-dlp, ffmpeg, JavaScript runtime, and Chromium with dependencies
# Dependencies needed for --cookies-from-browser support:
# - sqlite3: for reading browser cookie databases
# - keyutils: for credential storage access
# - chromium: the browser itself
RUN apk add --no-cache \
    chromium \
    chromium-chromedriver \
    python3 \
    py3-pip \
    ffmpeg \
    nodejs \
    npm \
    curl \
    sqlite-libs \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir yt-dlp \
    && ln -sf /opt/venv/bin/yt-dlp /usr/local/bin/yt-dlp \
    && curl -fsSL https://deno.land/install.sh | sh \
    && mv /root/.deno/bin/deno /usr/local/bin/deno \
    && rm -rf /root/.deno

# Create Chromium profile directory for cookies
RUN mkdir -p /root/.config/chromium && \
    mkdir -p /root/.config/google-chrome

# Set Chromium environment variables
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
ENV CHROMIUM_BIN=/usr/bin/chromium-browser

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --omit=dev

# Copy application code
COPY . .

# Create downloads directory
RUN mkdir -p downloads

# Expose port
EXPOSE 3002

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3002

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3002/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Run the application
CMD ["npm", "start"]