import { startVitest } from '/build/apps/validation-executor/node_modules/vitest/dist/node.js';
import fixed from './vitest.config.mjs';
// No config discovery or package script. Only the image-owned configuration is supplied.
await startVitest('test', [], { config: false, root: '/input', run: true, watch: false }, fixed);
