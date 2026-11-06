# Octavo: web app + REST API + MCP endpoint in one container.
# Easiest: copy .env.example to .env, fill it in, then `docker compose up -d`.
# See docs/SELF_HOSTING.md.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/
# The desktop app (Electron) isn't needed in the container.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --workspace @octavo/core --workspace @octavo/server --workspace @octavo/web --include-workspace-root
COPY packages/core packages/core
COPY packages/server packages/server
COPY packages/web packages/web
RUN npm run build && npm prune --omit=dev --workspace @octavo/core --workspace @octavo/server --workspace @octavo/web --include-workspace-root

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    OCTAVO_VAULT=/vault \
    OCTAVO_HOST=0.0.0.0 \
    PORT=4321
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/package.json packages/web/
COPY --from=build /app/packages/web/dist packages/web/dist
COPY deploy/docker-entrypoint.sh /usr/local/bin/octavo-entrypoint
RUN mkdir -p /vault && chown node:node /vault
VOLUME /vault
EXPOSE 4321
# Starts as root only to fix /vault permissions, then runs as the "node" user.
ENTRYPOINT ["octavo-entrypoint"]
CMD ["node", "packages/server/dist/cli.js", "serve"]
