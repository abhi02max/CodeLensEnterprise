import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Review workspace' };

export default function RouteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
