import { structuredPatch } from 'diff';

export const DIRECT_DIFF_POLICY = 'base-target-lf-exact-v1';
export function directDiff(before: string, after: string, timeout: number) {
  const patch = structuredPatch('base', 'target', before, after, '', '', {
    context: 0,
    maxEditLength: 20000,
    timeout,
  });
  if (!patch) throw new Error('ML_DIFF_BOUND');
  let additions = 0,
    deletions = 0;
  const touched = new Set<number>();
  for (const h of patch.hunks) {
    let line = h.newStart;
    for (const text of h.lines) {
      if (text.startsWith('+')) {
        additions++;
        touched.add(line++);
      } else if (text.startsWith('-')) deletions++;
      else if (text.startsWith(' ')) line++;
    }
  }
  return { additions, deletions, touched };
}
