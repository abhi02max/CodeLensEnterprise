import { expect, it, vi } from 'vitest';
import { AuditService } from './audit.service';

it('critical transaction audit preserves safe metadata and propagates failure', async () => {
  const create = vi.fn(async () => ({}));
  const service = new AuditService({} as never);
  const input = {
    organizationId: 'org',
    action: 'review.submitted',
    actorId: 'user',
    resourceType: 'Review',
    metadata: { headSha: 'a'.repeat(40), token: 'not-for-audit' },
    userAgent: 'x'.repeat(600),
  };
  await service.recordInTransaction({ auditLog: { create } } as never, input);
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        actorType: 'USER',
        metadata: { headSha: 'a'.repeat(40), token: '[REDACTED]' },
        userAgent: 'x'.repeat(500),
      }),
    }),
  );
  create.mockRejectedValueOnce(new Error('audit failure'));
  await expect(
    service.recordInTransaction({ auditLog: { create } } as never, input),
  ).rejects.toThrow('audit failure');
});

it('ordinary noncritical audit remains best-effort', async () => {
  const create = vi.fn().mockRejectedValue(new Error('audit failure'));
  const service = new AuditService({ unscoped: { auditLog: { create } } } as never);
  await expect(
    service.record({ organizationId: 'org', action: 'ordinary', resourceType: 'Test' }),
  ).resolves.toBeUndefined();
});
