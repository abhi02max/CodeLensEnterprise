import { expect, it, vi } from 'vitest';
import { ValidationAiProviderService } from './validation-ai-provider.service';

function setup() {
  const config = {
    ai: {
      apiKeys: { openai: 'synthetic-provider-secret', anthropic: '', openrouter: '' },
      baseUrls: { openai: 'http://provider.invalid/v1', anthropic: '', openrouter: '' },
    },
    rag: { geminiApiKey: 'synthetic-embedding-secret' },
    jwtSecret: 'synthetic-signing-secret',
    jwtRefreshSecret: 'synthetic-refresh-secret',
    encryptionKey: 'synthetic-encryption-secret',
    github: { clientSecret: 'synthetic-oauth-secret', webhookSecret: 'synthetic-webhook-secret' },
  };
  const settings = { provider: 'OPENAI', model: 'review-model', allowExternalModelCalls: true };
  const policy = { getAiSettings: vi.fn(async () => settings) };
  return {
    settings,
    config,
    service: new ValidationAiProviderService(config as never, policy as never),
  };
}

it('collects configured secrets for packet/result redaction without exposing them as frozen settings', async () => {
  const f = setup();
  expect(f.service.secrets()).toHaveLength(7);
  const frozen = await f.service.settings('org');
  for (const secret of f.service.secrets()) expect(JSON.stringify(frozen)).not.toContain(secret);
});

it('fails closed when policy is disabled or changes after reservation', async () => {
  const f = setup(),
    frozen = await f.service.settings('org');
  f.settings.allowExternalModelCalls = false;
  await expect(f.service.resolve('org', frozen)).rejects.toThrow('PROVIDER_DISABLED');
  f.settings.allowExternalModelCalls = true;
  f.settings.model = 'other-model';
  await expect(f.service.resolve('org', frozen)).rejects.toThrow('PROVIDER_CONFIGURATION_CHANGED');
});

it('rejects model metadata containing a supplied secret before dispatch', async () => {
  const f = setup();
  f.settings.model = f.config.jwtSecret;
  await expect(f.service.settings('org')).rejects.toThrow('PROVIDER_CONFIGURATION');
});
