import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  PredictReviewTimeRequestSchema,
  PredictRiskRequestSchema,
  Role,
} from '@codelens/shared';
import { OrgId, RequireRole } from '../common/decorators';
import { UpstreamUnavailableError } from '../common/errors';
import { zodBody } from '../common/zod-validation.pipe';
import { MlService } from './ml.service';

/**
 * Direct access to the risk models.
 *
 * Exists for two legitimate uses: the ML risk analysis page recomputing a prediction with a
 * modified feature vector ("what if this had tests?"), and operators verifying the model after
 * a retrain. The normal path is the analysis pipeline, which extracts features
 * deterministically from a real diff.
 *
 * Features are accepted from the caller here, so predictions from this endpoint are NOT
 * persisted — a hand-supplied vector is a hypothetical, and recording it as a real prediction
 * would corrupt both the audit trail and any future training set.
 */
@ApiTags('ml')
@ApiBearerAuth('access-token')
@Controller('ml')
export class MlController {
  constructor(private readonly ml: MlService) {}

  @Post('predict-risk')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Predict risk for a supplied feature vector (not persisted; for what-if analysis)',
  })
  async predictRisk(
    @OrgId() organizationId: string,
    @Body(zodBody(PredictRiskRequestSchema))
    body: ReturnType<typeof PredictRiskRequestSchema.parse>,
  ) {
    const result = await this.ml.predictRisk({
      features: body.features,
      organizationId,
      includeExplanation: body.includeExplanation,
    });

    if (result.status === 'UNAVAILABLE') {
      throw new UpstreamUnavailableError('ml-service', result.reason);
    }

    return { ...result.prediction, persisted: false };
  }

  @Post('predict-review-time')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Estimate human review time for a supplied feature vector' })
  async predictReviewTime(
    @OrgId() organizationId: string,
    @Body(zodBody(PredictReviewTimeRequestSchema))
    body: ReturnType<typeof PredictReviewTimeRequestSchema.parse>,
  ) {
    const result = await this.ml.predictReviewTime({
      features: body.features,
      organizationId,
    });

    if (!result) {
      throw new UpstreamUnavailableError(
        'ml-service',
        'The ML service is unavailable, so review time cannot be estimated.',
      );
    }

    return result;
  }

  /**
   * Model metadata and the bagging-vs-boosting comparison.
   *
   * Returns 200 with `status: UNAVAILABLE` rather than an error when the service is down: this
   * backs a status panel, and a panel that errors is less useful than one that says the service
   * is unreachable.
   */
  @Get('models/status')
  @ApiOperation({ summary: 'Model metadata, metrics and the model comparison table' })
  async modelsStatus() {
    const result = await this.ml.modelsInfo();

    if (result.status === 'UNAVAILABLE') {
      return {
        status: 'UNAVAILABLE' as const,
        reason: result.reason,
        serviceUrl: this.ml.baseUrl,
        models: [],
        comparison: [],
      };
    }

    return {
      status: 'OK' as const,
      reason: null,
      serviceUrl: this.ml.baseUrl,
      featureSchemaVersion: result.info.feature_schema_version,
      activeRiskModel: result.info.active_risk_model,
      models: result.info.models,
      comparison: result.info.comparison,
    };
  }

  @Post('models/reload')
  @RequireRole(Role.ADMIN)
  @ApiOperation({ summary: 'Ask the ML service to reload artifacts after a retrain' })
  reload() {
    return this.ml.reloadModels();
  }
}
