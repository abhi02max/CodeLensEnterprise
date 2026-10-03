import { expect, it, vi } from 'vitest';
import { CollaborationProviderService } from './collaboration-provider.service';

it('fails closed when organization policy disables providers', async () => {
  const service = new CollaborationProviderService(
    { ai: { apiKeys: {}, baseUrls: {} } } as never,
    { getAiSettings: vi.fn(async () => ({ allowExternalModelCalls: false })) } as never,
  );
  await expect(service.resolve('org')).rejects.toThrow('PROVIDER_DISABLED');
});
it('fails truthfully when the configured provider lacks credentials without fallback', async () => {
  const service = new CollaborationProviderService(
    { ai: { apiKeys: {}, baseUrls: {} } } as never,
    {
      getAiSettings: vi.fn(async () => ({
        allowExternalModelCalls: true,
        provider: 'ANTHROPIC',
        model: 'configured-model',
      })),
    } as never,
  );
  await expect(service.resolve('org')).rejects.toThrow('PROVIDER_UNAVAILABLE');
});
