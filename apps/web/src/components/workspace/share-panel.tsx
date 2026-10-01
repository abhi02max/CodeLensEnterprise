'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Input,
  Label,
  Select,
} from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-client';
import { absoluteTime, relativeTime } from '@/lib/format';
import type { ReviewPermissions, ShareLinkView } from '@/lib/types';

/**
 * Share-link management.
 *
 * The created URL is shown once and never again, because only its sha256 is stored server-side.
 * That constraint is surfaced rather than hidden: the panel says so, and existing links list with
 * no URL, so nobody expects to come back later and copy it.
 */
export function SharePanel({
  sessionId,
  shareLinks,
  permissions,
}: {
  sessionId: string;
  shareLinks: ShareLinkView[];
  permissions: ReviewPermissions;
}) {
  const queryClient = useQueryClient();

  const [open, setOpen] = React.useState(false);
  const [scope, setScope] = React.useState<'SUMMARY' | 'FULL'>('FULL');
  const [hours, setHours] = React.useState(168);
  const [redactCode, setRedactCode] = React.useState(false);
  const [passphrase, setPassphrase] = React.useState('');
  const [created, setCreated] = React.useState<{ url: string; token: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const copyGeneration = React.useRef(0);
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const passphraseTooShort = passphrase.length > 0 && passphrase.trim().length < 8;

  const create = useMutation({
    mutationFn: () =>
      api.createShareLink(sessionId, {
        scope,
        expiresInHours: hours,
        redactCode,
        ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {}),
      }),
    onMutate: () => setError(null),
    onSuccess: (link) => {
      copyGeneration.current += 1;
      setCopied(false);
      setCreated({ url: link.url, token: link.token });
      setPassphrase('');
      void queryClient.invalidateQueries({ queryKey: ['review-session', sessionId] });
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not create the share link'),
  });

  const revoke = useMutation({
    mutationFn: (shareLinkId: string) => api.revokeShareLink(sessionId, shareLinkId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['review-session', sessionId] }),
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not revoke the link'),
  });

  const [showInactive, setShowInactive] = React.useState(false);

  const active = shareLinks.filter(
    (link) => !link.revokedAt && new Date(link.expiresAt).getTime() > Date.now(),
  );
  const inactive = shareLinks.filter(
    (link) => link.revokedAt || new Date(link.expiresAt).getTime() <= Date.now(),
  );

  const visibleLinks = (showInactive ? shareLinks : active).slice(0, 6);

  if (!permissions.canCreateShareLink) {
    return (
      <Card>
        <CardHeader title="Share" />
        <CardBody>
          <p className="text-xs text-slate-500">
            {permissions.deniedReasons.canCreateShareLink ??
              'Your role does not allow sharing this review externally.'}
          </p>
          {active.length > 0 && (
            <p className="mt-1.5 text-xs text-slate-500">
              {active.length} active share link{active.length === 1 ? '' : 's'} exist for this review.
            </p>
          )}
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Share"
        subtitle={`${active.length} active link${active.length === 1 ? '' : 's'}`}
        actions={
          <Button size="sm" onClick={() => setOpen((value) => !value)}>
            {open ? 'Close' : 'New link'}
          </Button>
        }
      />

      {open && (
        <div className="space-y-2.5 border-b border-surface-border px-4 py-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="share-scope">Scope</Label>
              <Select
                id="share-scope"
                className="mt-1 w-full"
                value={scope}
                onChange={(event) => setScope(event.target.value as 'SUMMARY' | 'FULL')}
              >
                <option value="SUMMARY">Summary — risk and counts</option>
                <option value="FULL">Full — findings and narrative</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="share-hours">Expires in</Label>
              <Select
                id="share-hours"
                className="mt-1 w-full"
                value={hours}
                onChange={(event) => setHours(Number(event.target.value))}
              >
                <option value={24}>24 hours</option>
                <option value={168}>7 days</option>
                <option value={720}>30 days</option>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="share-passphrase">Passphrase (optional, min 8 characters)</Label>
            <Input
              id="share-passphrase"
              type="password"
              className="mt-1"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              aria-invalid={passphraseTooShort || undefined}
              aria-describedby={passphraseTooShort ? 'share-passphrase-error' : undefined}
              placeholder="Leave blank for no passphrase"
            />
            {passphraseTooShort && (
              <p id="share-passphrase-error" className="mt-1 text-xs text-red-700">
                Use at least 8 characters, or leave this blank.
              </p>
            )}
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={redactCode}
              onChange={(event) => setRedactCode(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-surface-border"
            />
            Redact source snippets
          </label>

          {error && <Alert tone="danger">{error}</Alert>}

          <Button variant="primary" loading={create.isPending} disabled={passphraseTooShort} onClick={() => create.mutate()}>
            Create link
          </Button>

          {created && (
            <Alert tone="info" title="Copy this now — it cannot be shown again">
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 font-mono text-xs text-slate-800">
                  {created.url}
                </code>
                <Button
                  size="sm"
                  onClick={async () => {
                    const generation = ++copyGeneration.current;
                    setError(null);
                    setCopied(false);
                    try {
                      await navigator.clipboard.writeText(created.url);
                      if (generation === copyGeneration.current) setCopied(true);
                    } catch {
                      if (generation === copyGeneration.current) {
                        setError('Could not copy the link. Copy it manually.');
                      }
                    }
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="mt-1.5 text-xs">
                Only a hash of the token is stored, so this URL is unrecoverable. Anyone holding it
                can read the review until it expires or is revoked.
              </p>
              <a
                href={`/shared/${created.token}`}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-1 inline-block text-xs underline"
              >
                Open the shared view
              </a>
            </Alert>
          )}
        </div>
      )}

      {/*
        Active links first, and only those, until asked otherwise. Revoked and expired rows are kept
        by the API on purpose — they are the record of who shared a review and when it was cut off —
        but a demo pull request accumulates them, and this panel measured 1747px before it stopped
        rendering every one of them by default.
      */}
      {visibleLinks.length > 0 && (
        <ul className="divide-y divide-surface-border">
          {visibleLinks.map((link) => {
            const expired = new Date(link.expiresAt).getTime() < Date.now();

            return (
              <li key={link.id} className="flex items-start justify-between gap-2 px-4 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="outline">{link.scope.toLowerCase()}</Badge>
                    {link.hasPassphrase && <Badge tone="neutral">passphrase</Badge>}
                    {link.redactCode && <Badge tone="neutral">redacted</Badge>}
                    {link.revokedAt ? (
                      <Badge tone="danger">revoked</Badge>
                    ) : expired ? (
                      <Badge tone="warning">expired</Badge>
                    ) : (
                      <Badge tone="success">active</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    by {link.createdBy.name} · {link.viewCount} view
                    {link.viewCount === 1 ? '' : 's'} ·{' '}
                    {link.revokedAt
                      ? `revoked ${relativeTime(link.revokedAt)}`
                      : `expires ${absoluteTime(link.expiresAt)}`}
                  </p>
                </div>

                {!link.revokedAt && permissions.canRevokeShareLink && (
                  <Button
                    size="sm"
                    variant="danger"
                    loading={revoke.isPending}
                    onClick={() => revoke.mutate(link.id)}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {active.length === 0 && !showInactive && (
        <div className="px-4 py-3">
          <p className="text-xs text-slate-500">No active share links.</p>
        </div>
      )}

      {inactive.length > 0 && (
        <button
          type="button"
          onClick={() => setShowInactive((value) => !value)}
          className="w-full border-t border-surface-border px-4 py-2 text-xs font-medium text-slate-600 hover:bg-surface-subtle"
        >
          {showInactive ? 'Hide' : 'Show'} {inactive.length} revoked or expired
        </button>
      )}
    </Card>
  );
}
