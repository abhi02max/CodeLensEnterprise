import { expect, it } from 'vitest';
import { executeMaterialization } from './materialize';

it('fails closed outside the dedicated Linux non-root executor boundary', async () => {
  await expect(executeMaterialization({ command: 'anything' }, '.')).rejects.toThrow(
    'PRECONDITION',
  );
});
