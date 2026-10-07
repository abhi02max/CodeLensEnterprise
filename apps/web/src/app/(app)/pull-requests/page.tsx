import { redirect } from 'next/navigation';
import { readReviewQuery, reviewsHref } from '@/lib/review-inbox';

export default async function LegacyPullRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === 'string') params.set(key, value);
  }
  redirect(reviewsHref(readReviewQuery(params)));
}
