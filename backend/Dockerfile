FROM oven/bun:1.3 AS base
WORKDIR /app

# Install deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/

# Create data directory
RUN mkdir -p data

EXPOSE 10080

ENV PORT=10080
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/kcode.db

CMD ["bun", "run", "src/index.ts"]
