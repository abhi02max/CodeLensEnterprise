import {
  normalizePatch,
  patchHash,
  constructPatchFile as construct,
  canonicalPatch as canonical,
  PatchCoreError,
} from '@codelens/patch-core';
import { ValidationError } from '../common/errors';
export { normalizePatch, patchHash };
function domain<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PatchCoreError) throw new ValidationError(error.message);
    throw error;
  }
}
export function constructPatchFile(...args: Parameters<typeof construct>) {
  return domain(() => construct(...args));
}
export function canonicalPatch(...args: Parameters<typeof canonical>) {
  return domain(() => canonical(...args));
}
