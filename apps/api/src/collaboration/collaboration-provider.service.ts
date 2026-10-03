import { Injectable } from '@nestjs/common';
import { createProvider, CollaborationFailure } from '@codelens/ai-agent';
import { AppConfigService } from '../config/app-config.service';
import { PolicyService } from '../organizations/policy.service';

@Injectable()
export class CollaborationProviderService {
  constructor(
    private readonly config: AppConfigService,
    private readonly policy: PolicyService,
  ) {}
  async resolve(organizationId: string) {
    const settings = await this.policy.getAiSettings(organizationId);
    if (!settings.allowExternalModelCalls) throw new CollaborationFailure('PROVIDER_DISABLED');
    try {
      const provider = createProvider({
        provider: settings.provider,
        model: settings.model,
        apiKeys: this.config.ai.apiKeys,
        baseUrls: this.config.ai.baseUrls,
      });
      return { provider, model: settings.model };
    } catch {
      throw new CollaborationFailure('PROVIDER_UNAVAILABLE');
    }
  }
}
