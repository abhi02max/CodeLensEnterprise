import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Activity' };

export default function RouteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
