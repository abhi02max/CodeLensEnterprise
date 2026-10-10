import { redirect } from 'next/navigation';

/** Historical share URLs use the same reader; no query parameters are forwarded. */
export default async function HistoricalSharedReviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  redirect(`/shared/${encodeURIComponent(token)}`);
}
