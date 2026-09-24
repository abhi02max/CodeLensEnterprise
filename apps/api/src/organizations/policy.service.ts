import { Injectable, Logger } from '@nestjs/common';
import {
  AiSettingsSchema,
  DEFAULT_REVIEW_POLICY,
  ReviewPolicySchema,
  Role,
  type AiSettings,
  type ReviewPolicy,
} from '@codelens/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * Review policy and AI settings access.
 *
 * Separated from OrganizationsService because the analysis pipeline reads policy on
 * every run, from background workers that have no interest in member management. Policy
 * is the input that makes the AI review *this organization's* review rather than a
 * generic one: it sets the blocking severity, the risk gate, whether tests are
 * mandatory, and whether the agent may post to GitHub at all.
 *
 * Cached in Redis with a short TTL because it is read on every pipeline stage and
 * changes rarely. Invalidated explicitly on write so an admin tightening the policy
 * sees it take effect immediately rather than after a TTL.
 */
@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);
  private static readonly CACHE_TTL_SECONDS = 300;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private policyKey(organizationId: string): string {
    return `policy:${organizationId}`;
  }

  private settingsKey(organizationId: string): string {
    return `aisettings:${organizationId}`;
  }

  /**
   * Effective review policy.
   *
   * Falls back to {@link DEFAULT_REVIEW_POLICY} when no row exists. Organizations are
   * created with a policy row, so this should not happen — but the pipeline must never
   * fail because a policy is missing, and defaulting is strictly better than throwing
   * halfway through an analysis run.
   */
  async getPolicy(organizationId: string): Promise<ReviewPolicy> {
    const cached = await this.redis.getJson<ReviewPolicy>(this.policyKey(organizationId));
    if (cached) return cached;

    const row = await this.prisma.unscoped.reviewPolicy.findUnique({
      where: { organizationId },
    });

    const policy: ReviewPolicy = row
      ? {
          blockingSeverity: row.blockingSeverity,
          riskScoreGate: row.riskScoreGate,
          requireTestsForCodeChanges: row.requireTestsForCodeChanges,
          minApprovals: row.minApprovals,
          sensitiveFlagsRequireTwoApprovals: row.sensitiveFlagsRequireTwoApprovals,
          autoPostGithubComment: row.autoPostGithubComment,
          blockOnSecretDetection: row.blockOnSecretDetection,
          githubCommentMinRole: row.githubCommentMinRole as Role,
          checklist: row.checklist,
          extraSemgrepRulesets: row.extraSemgrepRulesets,
          excludePatterns: row.excludePatterns,
        }
      : {
          ...DEFAULT_REVIEW_POLICY,
          checklist: [...DEFAULT_REVIEW_POLICY.checklist],
          extraSemgrepRulesets: [],
          excludePatterns: [],
        };

    await this.redis.setJson(
      this.policyKey(organizationId),
      policy,
      PolicyService.CACHE_TTL_SECONDS,
    );

    return policy;
  }

  async updatePolicy(
    organizationId: string,
    patch: Partial<ReviewPolicy>,
  ): Promise<ReviewPolicy> {
    // Validate the merged result rather than the patch alone, so a partial update
    // cannot produce an invalid combined policy.
    const merged = ReviewPolicySchema.parse({ ...(await this.getPolicy(organizationId)), ...patch });

    await this.prisma.unscoped.reviewPolicy.upsert({
      where: { organizationId },
      create: { organizationId, ...merged },
      update: merged,
    });

    await this.redis.del(this.policyKey(organizationId));
    this.logger.log(`Review policy updated for organization ${organizationId}`);

    return merged;
  }

  async getAiSettings(organizationId: string): Promise<AiSettings> {
    const cached = await this.redis.getJson<AiSettings>(this.settingsKey(organizationId));
    if (cached) return cached;

    const row = await this.prisma.unscoped.aiSettings.findUnique({ where: { organizationId } });

    const settings: AiSettings = {
      provider: (row?.provider ?? 'OPENAI') as AiSettings['provider'],
      model: row?.model ?? 'gpt-4o-mini',
      temperature: row?.temperature ?? 0.2,
      maxOutputTokens: row?.maxOutputTokens ?? 8000,
      maxCostCentsPerRun: row?.maxCostCentsPerRun ?? 50,
      allowExternalModelCalls: row?.allowExternalModelCalls ?? true,
      redactSecretsBeforeSend: row?.redactSecretsBeforeSend ?? true,
      embeddingProvider: (row?.embeddingProvider ?? 'openai') as AiSettings['embeddingProvider'],
      embeddingModel: row?.embeddingModel ?? 'text-embedding-3-small',
    };

    await this.redis.setJson(
      this.settingsKey(organizationId),
      settings,
      PolicyService.CACHE_TTL_SECONDS,
    );

    return settings;
  }

  async updateAiSettings(
    organizationId: string,
    patch: Partial<AiSettings>,
  ): Promise<AiSettings> {
    const merged = AiSettingsSchema.parse({
      ...(await this.getAiSettings(organizationId)),
      ...patch,
    });

    await this.prisma.unscoped.aiSettings.upsert({
      where: { organizationId },
      create: { organizationId, ...merged },
      update: merged,
    });

    await this.redis.del(this.settingsKey(organizationId));

    if (!merged.allowExternalModelCalls) {
      this.logger.log(
        `Organization ${organizationId} disabled external model calls; reviews will run ` +
          `static analysis and ML risk only.`,
      );
    }

    return merged;
  }
}
