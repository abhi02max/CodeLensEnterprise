import { Injectable } from '@nestjs/common';
import { createProvider, ValidationAiFailure } from '@codelens/ai-agent';
import { sanitizeDiagnosticText } from '@codelens/shared';
import { AppConfigService } from '../config/app-config.service';
import { PolicyService } from '../organizations/policy.service';
import { riskDigest } from '../ml/strict-risk-client';

@Injectable()
export class ValidationAiProviderService {
  constructor(
    private readonly config: AppConfigService,
    private readonly policy: PolicyService,
  ) {}
  secrets(): string[] {
    return [
      ...Object.values(this.config.ai.apiKeys),
      this.config.rag.geminiApiKey,
      this.config.jwtSecret,
      this.config.jwtRefreshSecret,
      this.config.encryptionKey,
      this.config.github.clientSecret,
      this.config.github.webhookSecret,
    ].filter(Boolean);
  }
  async settings(organizationId: string) {
    const settings = await this.policy.getAiSettings(organizationId);
    if (!settings.allowExternalModelCalls) throw new ValidationAiFailure('PROVIDER_DISABLED');
    if (
      !/^[a-zA-Z0-9._:/-]{1,128}$/.test(settings.model) ||
      sanitizeDiagnosticText(settings.model, this.secrets()) !== settings.model
    )
      throw new ValidationAiFailure('PROVIDER_CONFIGURATION');
    return {
      requestedProvider: settings.provider,
      requestedModel: settings.model,
      configurationDigest: riskDigest({
        provider: settings.provider,
        model: settings.model,
        baseUrls: this.config.ai.baseUrls,
      }),
    };
  }
  async resolve(
    organizationId: string,
    frozen: { requestedProvider: string; requestedModel: string; configurationDigest: string },
  ) {
    const settings = await this.settings(organizationId);
    if (settings.configurationDigest !== frozen.configurationDigest)
      throw new ValidationAiFailure('PROVIDER_CONFIGURATION_CHANGED');
    try {
      return createProvider({
        provider: settings.requestedProvider,
        model: settings.requestedModel,
        apiKeys: this.config.ai.apiKeys,
        baseUrls: this.config.ai.baseUrls,
      });
    } catch {
      throw new ValidationAiFailure('PROVIDER_UNAVAILABLE');
    }
  }
}
