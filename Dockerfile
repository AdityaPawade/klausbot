FROM node:20-slim

# Install Claude CLI (adjust based on actual installation method)
# This is a placeholder - actual installation TBD in Phase 2
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy built application
COPY dist ./dist

# Create data directory
RUN mkdir -p /app/data

# Environment
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

# Run as non-root
RUN useradd -r -s /bin/false klausbot && chown -R klausbot:klausbot /app
USER klausbot

CMD ["node", "dist/index.js", "daemon"]
