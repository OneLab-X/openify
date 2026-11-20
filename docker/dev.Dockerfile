# Development image: full monorepo with dependencies; source folders are bind-mounted by
# docker-compose.dev.yml so `pnpm dev` hot-reloads every app and package.
FROM node:22.22.2-bookworm-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
 && pnpm turbo run build --filter="./packages/*" --filter="./packages/themes/*"
CMD ["pnpm", "turbo", "run", "dev", "--concurrency=20"]
