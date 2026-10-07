import type { PullRequestListItem, RiskLevel, Role } from './types';

export const REVIEWS_HOME = '/dashboard';
export const REVIEW_PAGE_SIZE = 25;
export type ReviewQuery = {
  repositoryId?: string;
  state?: PullRequestListItem['state'];
  riskLevel?: RiskLevel;
  sortBy: 'updatedAt' | 'riskScore';
  sortOrder: 'asc' | 'desc';
  page: number;
  pageSize: number;
};

export function readReviewQuery(params: Pick<URLSearchParams, 'get'>): ReviewQuery {
  const state = params.get('state');
  const risk = params.get('riskLevel');
  const repository = params.get('repositoryId');
  const page = Number(params.get('page') ?? 1);
  return {
    ...(repository && repository.length <= 64 ? { repositoryId: repository } : {}),
    ...(['OPEN', 'CLOSED', 'MERGED', 'DRAFT'].includes(state ?? '')
      ? { state: state as ReviewQuery['state'] }
      : {}),
    ...(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(risk ?? '')
      ? { riskLevel: risk as RiskLevel }
      : {}),
    sortBy: params.get('sortBy') === 'riskScore' ? 'riskScore' : 'updatedAt',
    sortOrder:
      params.get('sortBy') !== 'riskScore' && params.get('sortOrder') === 'asc' ? 'asc' : 'desc',
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: REVIEW_PAGE_SIZE,
  };
}

export function reviewsHref(query: Partial<ReviewQuery> = {}): string {
  const params = new URLSearchParams();
  for (const key of [
    'repositoryId',
    'state',
    'riskLevel',
    'sortBy',
    'sortOrder',
    'page',
  ] as const) {
    const value = query[key];
    if (value !== undefined && value !== '' && !(key === 'page' && value === 1))
      params.set(key, String(value));
  }
  return `${REVIEWS_HOME}${params.size ? `?${params}` : ''}`;
}

export function hasReviewFilters(query: ReviewQuery): boolean {
  return Boolean(query.repositoryId || query.state || query.riskLevel);
}

export function primaryDestinations(role: Role | null) {
  return [
    { href: REVIEWS_HOME, label: 'Reviews' },
    { href: '/repositories', label: 'Repositories' },
    ...(role === 'ADMIN' || role === 'OWNER' ? [{ href: '/activity', label: 'History' }] : []),
  ];
}

export function isDestinationActive(href: string, pathname: string): boolean {
  if (href === REVIEWS_HOME)
    return (
      pathname === REVIEWS_HOME || pathname === '/pull-requests' || pathname.startsWith('/reviews/')
    );
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function reviewEmptyKind(repositoryCount: number, query: ReviewQuery) {
  if (query.page > 1) return 'page' as const;
  if (hasReviewFilters(query)) return 'filtered' as const;
  return repositoryCount === 0 ? ('repositories' as const) : ('reviews' as const);
}
