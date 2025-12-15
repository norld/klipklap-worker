# Use Node.js runtime
FROM node:18-alpine

# Install yt-dlp, ffmpeg, and JavaScript runtime
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    nodejs \
    npm \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir yt-dlp \
    && ln -sf /opt/venv/bin/yt-dlp /usr/local/bin/yt-dlp \
    && npm install -g deno

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
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Run the application
CMD ["npm", "start"]