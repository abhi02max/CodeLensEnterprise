'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { Alert, Badge, Button, Input, Label, Select } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { absoluteTime } from '@/lib/format';
import { actionFence, safeActionError, shareInputValid, shareStatus } from '@/lib/review-decision';
import type { ReviewPermissions, ShareLinkView } from '@/lib/types';
import { ReviewConfirmation } from './review-confirmation';

export function SharePanel({
  sessionId,
  shareLinks,
  permissions,
}: {
  sessionId: string;
  shareLinks: ShareLinkView[];
  permissions: ReviewPermissions;
}) {
  const client = useQueryClient();
  const [scope, setScope] = React.useState<'SUMMARY' | 'FULL'>('SUMMARY');
  const [hours, setHours] = React.useState(168);
  const [redactCode, setRedactCode] = React.useState(true);
  const [passphrase, setPassphrase] = React.useState('');
  const [issued, setIssued] = React.useState<{ id: string; url: string; scope: string } | null>(
    null,
  );
  const [confirmation, setConfirmation] = React.useState<'create' | string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [limit, setLimit] = React.useState(10);
  const generation = React.useRef(0);
  const fence = React.useRef(actionFence()).current;
  const valid = shareInputValid(passphrase, hours);
  const selected = shareLinks.find((link) => link.id === confirmation);
  const permitted =
    confirmation === 'create'
      ? permissions.canCreateShareLink && valid
      : !!selected && !selected.revokedAt && permissions.canRevokeShareLink;
  React.useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const operation = useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: async () => {
      if (!permitted || !confirmation) throw new Error('Sharing unavailable');
      if (confirmation === 'create') {
        generation.current++;
        setIssued(null);
        setCopied(false);
        const link = await api.createShareLink(sessionId, {
          scope,
          expiresInHours: hours,
          redactCode,
          ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {}),
        });
        // Return no credential-bearing mutation result or variables to the query cache.
        setIssued({ id: link.id, url: link.url, scope: link.scope });
        setPassphrase('');
        setNotice(
          'Share link created. Preserve the URL privately; it cannot be recovered from history.',
        );
      } else {
        await api.revokeShareLink(sessionId, confirmation);
        if (issued?.id === confirmation) {
          generation.current++;
          setIssued(null);
          setCopied(false);
        }
        setNotice('Revocation confirmed by the server.');
      }
      void client.invalidateQueries({ queryKey: ['review-session', sessionId] });
    },
  });
  const send = async () => {
    if (!permitted || !confirmation || !fence.acquire()) return;
    const action = confirmation === 'create' ? 'Create share link' : 'Revoke share link';
    setError(null);
    setNotice(null);
    try {
      await operation.mutateAsync();
    } catch (caught) {
      setError(safeActionError(caught, action));
    } finally {
      setConfirmation(null);
      fence.release();
    }
  };
  return (
    <section aria-label="Review sharing" className="decision-sharing">
      <h2>Review sharing</h2>
      <p>
        Anyone with a bearer URL can access its permitted view until expiry or revocation; an
        optional passphrase adds a separate check. Share privately.
      </p>
      <p>
        Shared reads show permitted recorded review data, not a frozen decision snapshot. Private
        collaboration and candidate execution records are not included.
      </p>
      {!permissions.canCreateShareLink ? (
        <Alert tone="info">
          {permissions.deniedReasons.canCreateShareLink ||
            'Your role does not allow external sharing.'}
        </Alert>
      ) : (
        <div className="decision-sharing-form">
          <div>
            <Label htmlFor="share-scope">Visibility</Label>
            <Select
              id="share-scope"
              value={scope}
              disabled={operation.isPending}
              onChange={(e) => {
                setScope(e.target.value as 'SUMMARY' | 'FULL');
                setConfirmation(null);
              }}
            >
              <option value="SUMMARY">Summary: risk and counts</option>
              <option value="FULL">Full: findings and narrative</option>
            </Select>
            <p>
              {scope === 'SUMMARY'
                ? 'Includes the permitted executive summary, risk and counts.'
                : 'Includes permitted findings and AI narrative. Review sensitive content before sharing.'}
            </p>
          </div>
          <div>
            <Label htmlFor="share-hours">Expires in</Label>
            <Select
              id="share-hours"
              value={hours}
              disabled={operation.isPending}
              onChange={(e) => {
                setHours(Number(e.target.value));
                setConfirmation(null);
              }}
            >
              <option value={24}>24 hours</option>
              <option value={168}>7 days</option>
              <option value={720}>30 days</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="share-passphrase">Optional passphrase</Label>
            <Input
              id="share-passphrase"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              disabled={operation.isPending}
              aria-invalid={!valid || undefined}
              aria-describedby="share-passphrase-help"
              onChange={(e) => {
                setPassphrase(e.target.value);
                setConfirmation(null);
              }}
            />
            <p id="share-passphrase-help">
              Leave blank or use 8-200 characters. Send separately; it is never appended to the URL.
            </p>
          </div>
          <label>
            <input
              type="checkbox"
              checked={redactCode}
              disabled={operation.isPending}
              onChange={(e) => {
                setRedactCode(e.target.checked);
                setConfirmation(null);
              }}
            />{' '}
            Redact static source snippets
          </label>
          <p>
            Snippet redaction does not guarantee removal of sensitive content from AI narrative.
          </p>
          <div className="decision-actions">
            <Button
              variant="primary"
              disabled={!valid || operation.isPending}
              onClick={() => {
                setError(null);
                setConfirmation('create');
              }}
            >
              Review new share link
            </Button>
          </div>
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {issued && permissions.canCreateShareLink && (
        <div aria-label="Newly issued share URL">
          <p>{issued.scope} URL; available only in this mounted view.</p>
          <code>{issued.url}</code>
          <div className="decision-actions">
            <Button
              size="sm"
              title="Copy newly issued share URL"
              onClick={async () => {
                const copy = ++generation.current;
                setCopied(false);
                setError(null);
                try {
                  await navigator.clipboard.writeText(issued.url);
                  if (copy === generation.current) setCopied(true);
                } catch {
                  if (copy === generation.current)
                    setError('Could not copy the link. Copy it manually.');
                }
              }}
            >
              <Copy size={14} aria-hidden="true" />
              {copied ? 'Copied' : 'Copy share URL'}
            </Button>
            <a href={issued.url} target="_blank" rel="noreferrer noopener">
              Open shared review
            </a>
          </div>
        </div>
      )}
      <h3>Recorded share metadata</h3>
      <p>
        Previously issued URLs and passphrases are not recoverable. This list is not a complete
        access audit.
      </p>
      {!shareLinks.length ? (
        <p>No share metadata returned by this read.</p>
      ) : (
        <ul>
          {shareLinks.slice(0, limit).map((link) => (
            <li key={link.id}>
              <div className="decision-history-heading">
                <Badge>{link.scope}</Badge>
                <span>{shareStatus(link, Date.now())}</span>
              </div>
              <p>
                Created {absoluteTime(link.createdAt)} by {link.createdBy.name} / {link.viewCount}{' '}
                recorded views
              </p>
              <p>
                Recorded expiry {absoluteTime(link.expiresAt)}
                {link.revokedAt ? ` / revoked ${absoluteTime(link.revokedAt)}` : ''}
              </p>
              <p>
                {link.hasPassphrase ? 'Passphrase protected' : 'No passphrase'} /{' '}
                {link.redactCode
                  ? 'Static snippets redacted'
                  : 'Static snippets visible in FULL scope'}
              </p>
              {!link.revokedAt && permissions.canRevokeShareLink && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={operation.isPending}
                  onClick={() => {
                    setError(null);
                    setConfirmation(link.id);
                  }}
                >
                  Review revocation
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p>
        {Math.min(limit, shareLinks.length)} of {shareLinks.length} returned records. No server
        pagination is provided.
      </p>
      {limit < shareLinks.length && (
        <Button onClick={() => setLimit((n) => n + 10)}>Show more share records</Button>
      )}
      <ReviewConfirmation
        open={!!confirmation && permitted}
        title={confirmation === 'create' ? 'Create share link' : 'Revoke share link'}
        busy={operation.isPending}
        close={() => setConfirmation(null)}
        confirm={() => void send()}
      >
        {confirmation === 'create' ? (
          <>
            <p>
              {scope} visibility / {hours} hours /{' '}
              {redactCode ? 'static snippets redacted' : 'static snippets visible'} /{' '}
              {passphrase.trim() ? 'passphrase protected' : 'no passphrase'}.
            </p>
            <p>
              This creates an externally accessible bearer URL. No GitHub or repository change
              occurs.
            </p>
          </>
        ) : (
          <p>
            Revoke this recorded {selected?.scope} link, created{' '}
            {selected && absoluteTime(selected.createdAt)}. Future access through this link will be
            denied by the server.
          </p>
        )}
      </ReviewConfirmation>
    </section>
  );
}
