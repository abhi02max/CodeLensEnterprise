import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Reviews' };

export default function RouteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
