import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { ValidationAiController } from './validation-ai.controller';
import { ValidationMlController } from './validation-ml.controller';

describe.each([
  ['ML assessment', ValidationMlController, 'comparisonId'],
  ['AI re-review', ValidationAiController, 'reviewId'],
] as const)('%s nullable readback', (_name, Controller, queryKey) => {
  it.each([null, { id: 'persisted-result' }])('writes the JSON contract for %j', async (result) => {
    const get = vi.fn().mockResolvedValue(result);
    const controller = new Controller({ get } as never);
    const json = vi.fn().mockReturnValue('sent');
    const response = { json } as unknown as Response;
    await expect(
      controller.get(
        'org',
        { userId: 'user' } as never,
        'trace',
        'validation',
        { [queryKey]: 'requested-result' },
        response,
      ),
    ).resolves.toBe('sent');
    expect(get).toHaveBeenCalledWith(
      { organizationId: 'org', userId: 'user', traceId: 'trace' },
      'validation',
      'requested-result',
    );
    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith(result);
  });

  it('propagates scoped service errors without sending a success body', async () => {
    const get = vi.fn().mockRejectedValue(new Error('scoped denial'));
    const controller = new Controller({ get } as never);
    const json = vi.fn();
    await expect(
      controller.get('org', { userId: 'user' } as never, 'trace', 'validation', {}, {
        json,
      } as unknown as Response),
    ).rejects.toThrow('scoped denial');
    expect(json).not.toHaveBeenCalled();
  });
});
