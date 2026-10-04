FROM node:22-bookworm-slim AS build
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/validation-executor/package.json ./apps/validation-executor/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @codelens/validation-executor...
COPY packages/shared ./packages/shared
COPY apps/validation-executor ./apps/validation-executor
RUN pnpm --filter @codelens/shared build && pnpm --filter @codelens/validation-executor build && pnpm --filter @codelens/validation-executor test && pnpm --filter @codelens/validation-executor bundle

FROM gcr.io/distroless/nodejs22-debian12@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
ARG BUNDLE_DIGEST
ARG CONFIGURATION_DIGEST
LABEL com.codelens.validation.bundle=$BUNDLE_DIGEST
LABEL com.codelens.validation.configuration=$CONFIGURATION_DIGEST
COPY --from=build /build/node_modules /build/node_modules
COPY --from=build /build/apps/validation-executor/node_modules /build/apps/validation-executor/node_modules
COPY --from=build --chown=65532:65532 /build/apps/validation-executor/dist/runtime/main.js /runner.cjs
COPY --from=build /build/apps/validation-executor/dist/runtime/prepare.js /prepare.cjs
COPY infra/validation/vitest.config.mjs /policy/vitest.config.mjs
COPY infra/validation/vitest-runner.mjs /policy/vitest-runner.mjs
USER 65532:65532
WORKDIR /input
ENTRYPOINT ["/nodejs/bin/node", "/runner.cjs"]
CMD []
