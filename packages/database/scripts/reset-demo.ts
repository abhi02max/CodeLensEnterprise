/**
 * Reset the collaboration layer of the demo organization.
 *
 *   pnpm db:reset-demo
 *
 * Removes comments, human verdicts and share links, and prunes review runs down to the most recent
 * completed one per pull request. Leaves the organization, users, repository, pull requests and the
 * surviving analysis intact, so the review workspace still has real findings, a risk score and
 * retrieved context to render immediately afterwards.
 *
 * Why this exists: every demo and every verification pass adds threads, verdicts and share links to
 * the same seeded pull request. After a dozen runs the Discussion panel was 2544px tall and the
 * Share panel 1747px — measured, not guessed — which buried the AI review and the merge gate under
 * accumulated noise. Re-seeding is not an alternative because the seed upserts and would leave the
 * accumulation in place.
 *
 * Deliberately narrow and guarded:
 *   - scoped to one organization slug, defaulting to the seeded demo org
 *   - refuses to run with NODE_ENV=production
 *   - prints what it is about to delete, and what it kept
 */
import { PrismaClient, ReviewRunStatus } from '@prisma/client';

const prisma = new PrismaClient();

const SLUG = process.env.DEMO_ORG_SLUG ?? 'acme-engineering';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'reset-demo refuses to run with NODE_ENV=production. It deletes review history.',
    );
  }

  const organization = await prisma.organization.findUnique({
    where: { slug: SLUG },
    select: { id: true, name: true, slug: true },
  });

  if (!organization) {
    throw new Error(
      `No organization with slug "${SLUG}". Run \`pnpm db:seed\` first, or set DEMO_ORG_SLUG.`,
    );
  }

  console.log(`Resetting demo state for ${organization.name} (${organization.slug})\n`);

  const before = await counts(organization.id);
  console.log('before:', format(before));

  // ---- collaboration layer
  //
  // Comments cascade to their replies through the self-relation, so deleting by organization is
  // enough; no ordering games are needed.
  const comments = await prisma.comment.deleteMany({ where: { organizationId: organization.id } });
  const reviews = await prisma.review.deleteMany({ where: { organizationId: organization.id } });
  const shareLinks = await prisma.shareLink.deleteMany({
    where: { organizationId: organization.id },
  });

  // ---- prune review runs, keeping the newest COMPLETED one per pull request
  //
  // The newest run is what every screen reads, and keeping one preserves a demo-ready workspace
  // while removing the dozens of forced re-runs a verification pass leaves behind. Findings,
  // predictions, retrieved context and tool runs cascade from ReviewRun.
  //
  // Only a COMPLETED run is a keeper. Keeping whichever run is simply newest let a FAILED run
  // survive and become the state the UI reports: PR #415 is seeded as un-analysed on purpose, so
  // the demo can show the "Not analysed yet" state, but one experimental analyze call against it
  // left a run stuck at FETCHING_DIFF and the pull request list showed FAILED from then on. A
  // pull request with no completed run goes back to having no runs at all.
  const pullRequests = await prisma.pullRequest.findMany({
    where: { organizationId: organization.id },
    select: { id: true, number: true },
  });

  let prunedRuns = 0;

  for (const pullRequest of pullRequests) {
    const runs = await prisma.reviewRun.findMany({
      where: { pullRequestId: pullRequest.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });

    const keeper = runs.find((run) => run.status === ReviewRunStatus.COMPLETED);
    const stale = runs.filter((run) => run.id !== keeper?.id).map((run) => run.id);
    if (stale.length === 0) continue;

    const deleted = await prisma.reviewRun.deleteMany({ where: { id: { in: stale } } });
    prunedRuns += deleted.count;
    console.log(
      `  pruned ${deleted.count} run(s) on PR #${pullRequest.number}` +
        (keeper ? '' : ' (none had completed, so it is un-analysed again)'),
    );
  }

  // ---- reset the human-verdict training labels
  //
  // wasRisky and firstReviewedAt are written by verdict submission. Leaving them set after the
  // verdicts are gone would present labels with nothing behind them.
  const labels = await prisma.pullRequest.updateMany({
    where: { organizationId: organization.id },
    data: { firstReviewedAt: null, actualReviewMinutes: null, wasRisky: null, riskLabelReason: null },
  });

  console.log('\ndeleted:');
  console.log(`  ${comments.count} comment(s)`);
  console.log(`  ${reviews.count} review verdict(s)`);
  console.log(`  ${shareLinks.count} share link(s)`);
  console.log(`  ${prunedRuns} superseded review run(s)`);
  console.log(`  cleared verdict-derived labels on ${labels.count} pull request(s)`);

  const after = await counts(organization.id);
  console.log('\nafter: ', format(after));

  if (after.reviewRuns === 0) {
    console.log(
      '\nNote: no review run survived, so the workspace will show "Not analysed yet".\n' +
        'Run an analysis from the Pull requests page, or `pnpm db:seed` to restore the seeded run.',
    );
  } else {
    console.log('\nThe review workspace still has a completed run to render.');
  }
}

async function counts(organizationId: string) {
  const [comments, reviews, shareLinks, reviewRuns, findings, auditLogs] = await Promise.all([
    prisma.comment.count({ where: { organizationId } }),
    prisma.review.count({ where: { organizationId } }),
    prisma.shareLink.count({ where: { organizationId } }),
    prisma.reviewRun.count({ where: { organizationId } }),
    prisma.staticFinding.count({ where: { organizationId } }),
    prisma.auditLog.count({ where: { organizationId } }),
  ]);

  return { comments, reviews, shareLinks, reviewRuns, findings, auditLogs };
}

function format(value: Awaited<ReturnType<typeof counts>>): string {
  return (
    `${value.comments} comments, ${value.reviews} verdicts, ${value.shareLinks} share links, ` +
    `${value.reviewRuns} runs, ${value.findings} findings, ${value.auditLogs} audit entries`
  );
}

void main()
  .catch((error: unknown) => {
    console.error(`\nreset-demo failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
