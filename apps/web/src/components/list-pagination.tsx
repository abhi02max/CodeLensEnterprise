'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as React from 'react';
import { Button } from './ui/primitives';

export function ListPagination({
  page,
  pageSize,
  total,
  totalPages,
  pending,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  pending?: boolean;
  onPage: (page: number) => void;
}) {
  const start = total === 0 || page > totalPages ? 0 : (page - 1) * pageSize + 1;
  const end = start === 0 ? 0 : Math.min(page * pageSize, total);
  return (
    <nav
      aria-label="List pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-structure py-3 text-metadata text-content-muted"
    >
      <span>
        {start === 0 ? '0 shown' : `${start}-${end}`} of {total}
      </span>
      <div className="flex items-center gap-2">
        <span>
          Page {page} of {Math.max(1, totalPages)}
        </span>
        <Button
          title="Previous page"
          aria-label="Previous page"
          size="sm"
          disabled={pending || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          title="Next page"
          aria-label="Next page"
          size="sm"
          disabled={pending || page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
