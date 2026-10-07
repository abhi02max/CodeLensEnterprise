import { Suspense } from 'react';
import { ReviewInbox } from '@/components/reviews/review-inbox';
import { ReviewListLoading } from '@/components/reviews/review-list';

export default function ReviewsPage() {
  return (
    <Suspense fallback={<ReviewListLoading />}>
      <ReviewInbox />
    </Suspense>
  );
}
