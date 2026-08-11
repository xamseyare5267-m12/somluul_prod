# SomLuul Production — always-on container (Railway / Render / Fly / VPS)
# No cold starts. Single process = reliable chat SSE + WebRTC signaling + posts.

FROM node:20-bookworm-slim

WORKDIR /app

# System deps for native modules if needed
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts 2>/dev/null || npm install --ignore-scripts

COPY . .

# Build frontend + bundle server
ENV NODE_ENV=production
RUN npx vite build && \
    npx esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs

# Persistent data + uploads (mount volume at /data in Railway/Render)
ENV DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000

# Healthcheck so platform restarts only if truly dead
HEALTHCHECK --interval=30s --timeout=8s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.cjs"]
