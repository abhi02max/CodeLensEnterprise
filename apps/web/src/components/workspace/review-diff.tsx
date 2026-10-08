'use client';

import * as React from 'react';
import type { PullRequestFileView } from '@codelens/shared';
import {
  parseUnifiedPatch,
  patchState,
  type DiffIdentity,
  type WorkspaceFinding,
} from '@/lib/review-workspace';

export const ReviewDiff = React.memo(function ReviewDiff({
  file,
  identity,
  markers,
  selectedKey,
  onSelect,
  sourceLine,
}: {
  file: PullRequestFileView;
  identity: DiffIdentity;
  markers: Map<number, WorkspaceFinding[]>;
  selectedKey: string | null;
  onSelect: (finding: WorkspaceFinding) => void;
  sourceLine?: number;
}) {
  const show =
    identity.trusted &&
    (file.patchAvailability === 'AVAILABLE' || file.patchAvailability === 'PARTIAL');
  const hunks = React.useMemo(
    () => (show ? parseUnifiedPatch(file.patch ?? '') : []),
    [file.patch, show],
  );
  return (
    <section aria-label={`Diff for ${file.filename}`} className="review-diff">
      <header className="review-file-heading">
        <h2>{file.filename}</h2>
        <span>
          {file.status} / {file.language ?? 'language unknown'}
        </span>
        {file.previousFilename && <span>Previously {file.previousFilename}</span>}
        <span className="review-counts">
          +{file.additions} / -{file.deletions}
        </span>
      </header>
      <p className="review-patch-state" role="status">
        {identity.trusted ? patchState(file) : identity.reason}
      </p>
      {show && hunks.length > 0 ? (
        <div
          className="review-code-scroll"
          tabIndex={0}
          aria-label="Unified diff, horizontal scrolling available"
        >
          <table className="review-code-table" aria-label="Old and new line coordinates">
            <thead className="sr-only">
              <tr>
                <th>Old line</th>
                <th>New line</th>
                <th>Findings</th>
                <th>Change</th>
                <th>Code</th>
              </tr>
            </thead>
            <tbody>
              {hunks.map((hunk, h) => (
                <React.Fragment key={h}>
                  <tr className="review-hunk">
                    <td colSpan={5}>{hunk.header}</td>
                  </tr>
                  {hunk.lines.map((line, index) => {
                    const found =
                      line.newLineNumber === null ? [] : (markers.get(line.newLineNumber) ?? []);
                    const selected = found.some((f) => f.key === selectedKey);
                    return (
                      <tr
                        key={index}
                        data-new-line={line.newLineNumber ?? undefined}
                        data-selected={selected || line.newLineNumber === sourceLine || undefined}
                        className={`review-code-${line.type}`}
                      >
                        <td className="review-coordinate">{line.oldLineNumber}</td>
                        <td className="review-coordinate">{line.newLineNumber}</td>
                        <td className="review-line-marker">
                          {found.length > 0 && (
                            <button
                              type="button"
                              aria-label={`${found.length} findings on NEW line ${line.newLineNumber}`}
                              title={`${found.length} findings on NEW line ${line.newLineNumber}`}
                              onClick={() => onSelect(found[0]!)}
                            >
                              {found.length}
                            </button>
                          )}
                        </td>
                        <td
                          aria-label={
                            line.type === 'add'
                              ? 'Added'
                              : line.type === 'del'
                                ? 'Deleted'
                                : 'Context'
                          }
                        >
                          {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                        </td>
                        <td>
                          <code>{line.content || ' '}</code>
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          {file.patch?.includes('\\ No newline at end of file') && (
            <p className="review-no-newline">\ No newline at end of file (patch metadata)</p>
          )}
        </div>
      ) : (
        show && (
          <p className="review-patch-state">
            No renderable hunks in the supplied patch. No source content has been inferred.
          </p>
        )
      )}
    </section>
  );
});
