FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/sandbox-broker ./apps/sandbox-broker
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate && pnpm build:packages && pnpm --filter @codelens/api build

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
RUN pnpm --version
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/sandbox-broker ./apps/sandbox-broker
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
