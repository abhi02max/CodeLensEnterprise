import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  PrismaClient,
  createPrismaClient,
  criticalSchemaIssues,
  forOrganization,
  readDatabaseSnapshot,
  type ScopedPrismaClient,
} from '@codelens/database';
import { AppConfigService } from '../config/app-config.service';

/**
 * Prisma lifecycle and tenant scoping.
 *
 * COMPOSITION, NOT INHERITANCE — and this is a correctness requirement, not taste.
 *
 * The common NestJS pattern is `class PrismaService extends PrismaClient`. That breaks
 * on Prisma 6: the PrismaClient constructor returns a Proxy, and the proxy's `get`
 * handler resolves properties against its internal target without forwarding the
 * receiver. Inside a getter declared on the subclass prototype, `this` therefore binds
 * to the raw target rather than to the proxy, and the raw target has none of the model
 * delegates. Concretely, with inheritance:
 *
 *     get unscoped() { return this; }      // returns the target, not the proxy
 *     this.prisma.unscoped.user            // undefined
 *     -> "Cannot read properties of undefined (reading 'findUnique')"
 *
 * Holding the client as a field sidesteps the whole interaction, and has the secondary
 * benefit of not spilling a hundred-odd Prisma delegate properties onto a Nest service.
 *
 * Responsibilities:
 *
 * 1. Connection lifecycle bound to the Nest lifecycle, so the pool closes on shutdown.
 *
 * 2. Handing out tenant-scoped clients via {@link forOrg}. Use of {@link unscoped}
 *    should be rare and deliberate, because the scoped client injects `organizationId`
 *    into every query against a tenant table — a forgotten `where` cannot leak across
 *    organizations.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly client: PrismaClient;

  /**
   * Scoped clients cached per organization. Each `$extends` call builds a new proxy
   * chain, so constructing one per request would add overhead on a hot path for no
   * benefit: the extension is stateless.
   */
  private readonly scopedCache = new Map<string, ScopedPrismaClient>();

  constructor(private readonly config: AppConfigService) {
    // DATABASE_URL is read from validated config rather than process.env, so the
    // client cannot be constructed with an unvalidated or missing URL.
    process.env.DATABASE_URL = config.databaseUrl;
    this.client = createPrismaClient();
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    this.logger.log('Database connected');

    const issues = criticalSchemaIssues(await readDatabaseSnapshot(this.client));
    if (issues.length > 0) {
      throw new Error(`Database schema is not ready:\n- ${issues.join('\n- ')}`);
    }
    this.logger.log('Database schema and RAG indexes verified');
  }

  async onModuleDestroy(): Promise<void> {
    this.scopedCache.clear();
    await this.client.$disconnect();
  }

  /**
   * Tenant-scoped client. This is the default way to touch the database: reads gain an
   * `organizationId` filter, writes gain the field, and updates are validated against
   * it.
   */
  forOrg(organizationId: string): ScopedPrismaClient {
    const cached = this.scopedCache.get(organizationId);
    if (cached) return cached;

    const scoped = forOrganization(organizationId, this.client);
    this.scopedCache.set(organizationId, scoped);
    return scoped;
  }

  /**
   * Unscoped client, for operations that legitimately cross tenants: authentication by
   * email, share-link resolution by token, and worker jobs that have not yet resolved
   * an organization.
   *
   * Named explicitly rather than exposed as a bare client so these call sites are easy
   * to grep and review.
   */
  get unscoped(): PrismaClient {
    return this.client;
  }

  /** Transaction helper on the unscoped client. */
  get $transaction(): PrismaClient['$transaction'] {
    return this.client.$transaction.bind(this.client);
  }

  async isHealthy(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const startedAt = Date.now();

    try {
      await this.client.$queryRawUnsafe('SELECT 1');
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
