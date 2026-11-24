# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci

# Copy source and build.
COPY . .
ENV PRISMA_SCHEMA_ENGINE=js
ENV CHECKPOINT_DISABLE=1
RUN npm run db:generate
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
ENV SERVE_FRONTEND=true
ENV PRISMA_SCHEMA_ENGINE=js
ENV CHECKPOINT_DISABLE=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

# Copy runtime dependencies and built app.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend ./backend
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/scripts ./scripts

# Persistent upload directory when using STORAGE_DRIVER=disk.
RUN mkdir -p /app/storage

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply migrations, then start the server.
CMD ["sh", "-c", "npm run db:deploy && npm run start"]
