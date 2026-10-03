FROM node:22-bookworm-slim AS build
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/github/package.json ./packages/github/package.json
COPY packages/patch-core/package.json ./packages/patch-core/package.json
COPY apps/sandbox-broker/package.json ./apps/sandbox-broker/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @codelens/sandbox-broker...
COPY packages/shared ./packages/shared
COPY packages/github ./packages/github
COPY packages/patch-core ./packages/patch-core
COPY apps/sandbox-broker ./apps/sandbox-broker
RUN pnpm --filter @codelens/sandbox-broker... build && pnpm --filter @codelens/sandbox-broker bundle

FROM gcr.io/distroless/nodejs22-debian12@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
COPY --from=build /build/apps/sandbox-broker/dist/broker.cjs /broker.cjs
COPY infra/sandbox/seccomp.json /policy/seccomp.json
USER 0:0
ENTRYPOINT ["/nodejs/bin/node", "/broker.cjs"]
CMD []
