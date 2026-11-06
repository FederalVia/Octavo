# Ultron Mind: web app + REST API + MCP endpoint in one container.
#   docker build -t ultron-mind .
#   docker run -p 4321:4321 -v ultron-vault:/vault -e ULTRON_TOKEN=change-me ultron-mind

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/
# The desktop app (Electron) isn't needed in the container.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --workspace @ultron/core --workspace @ultron/server --workspace @ultron/web --include-workspace-root
COPY packages/core packages/core
COPY packages/server packages/server
COPY packages/web packages/web
RUN npm run build && npm prune --omit=dev --workspace @ultron/core --workspace @ultron/server --workspace @ultron/web --include-workspace-root

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    ULTRON_VAULT=/vault \
    ULTRON_HOST=0.0.0.0 \
    PORT=4321
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/package.json packages/web/
COPY --from=build /app/packages/web/dist packages/web/dist
RUN mkdir -p /vault && chown node:node /vault
VOLUME /vault
EXPOSE 4321
USER node
CMD ["node", "packages/server/dist/cli.js", "serve"]
