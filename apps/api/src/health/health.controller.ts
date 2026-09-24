import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Aggregate health.
   *
   * Returns 503 when a required dependency is down so a load balancer or Kubernetes
   * readiness probe removes the instance. A `degraded` status still returns 200: the
   * ML service being unreachable must not take the API out of rotation, because
   * reviews continue to work without a risk score.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Aggregate health of the API and its dependencies' })
  @ApiResponse({ status: 200, description: 'Healthy or degraded but serving' })
  @ApiResponse({ status: 503, description: 'A required dependency is unavailable' })
  async overall(@Res({ passthrough: true }) response: Response) {
    const result = await this.health.overall();

    response.status(result.status === 'down' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK);
    return result;
  }

  /**
   * Liveness probe.
   *
   * Deliberately checks nothing: it answers "is this process running and able to
   * respond". A liveness probe that touches the database restarts healthy instances
   * during a database blip, turning a brief outage into a restart storm.
   */
  @Public()
  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness probe; does not touch dependencies' })
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('db')
  @ApiOperation({ summary: 'Postgres connectivity and latency' })
  async database(@Res({ passthrough: true }) response: Response) {
    const result = await this.health.database();
    response.status(result.ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }

  @Public()
  @Get('redis')
  @ApiOperation({ summary: 'Redis connectivity and latency' })
  async redis(@Res({ passthrough: true }) response: Response) {
    const result = await this.health.redisHealth();
    response.status(result.ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }

  /**
   * ML service reachability. Returns 200 even when the ML service is down, because
   * that is a degraded state for the product rather than a failure of this endpoint.
   */
  @Public()
  @Get('ml')
  @ApiOperation({ summary: 'ML service reachability and whether models are loaded' })
  async ml() {
    return this.health.mlHealth();
  }
}
