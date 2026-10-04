FROM node:22-bookworm-slim AS build
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/validation-executor/package.json ./apps/validation-executor/package.json
COPY apps/validation-broker/package.json ./apps/validation-broker/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @codelens/validation-broker...
COPY packages/shared ./packages/shared
COPY apps/validation-executor ./apps/validation-executor
COPY apps/validation-broker ./apps/validation-broker
RUN pnpm --filter @codelens/shared build && pnpm --filter @codelens/validation-executor build && pnpm --filter @codelens/validation-broker build && pnpm --filter @codelens/validation-broker test && pnpm --filter @codelens/validation-broker bundle

FROM gcr.io/distroless/nodejs22-debian12@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
COPY --from=build /build/apps/validation-broker/dist/runtime/main.js /broker.cjs
COPY --from=build /build/apps/validation-broker/dist/runtime/protocol.js /protocol.cjs
COPY infra/validation/seccomp.json /policy/seccomp.json
USER 0:0
ENTRYPOINT ["/nodejs/bin/node", "/broker.cjs"]
CMD []
