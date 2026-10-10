'use client';

import * as React from 'react';
import { Button } from '@/components/ui/primitives';

export function ReviewConfirmation({
  open,
  title,
  busy,
  close,
  confirm,
  children,
}: {
  open: boolean;
  title: string;
  busy: boolean;
  close: () => void;
  confirm: () => void;
  children: React.ReactNode;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const origin = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (open && !dialog.current?.open) {
      origin.current = document.activeElement as HTMLElement;
      dialog.current?.showModal();
    } else if (!open && dialog.current?.open) {
      dialog.current.close();
      if (origin.current?.isConnected) origin.current.focus();
    }
  }, [open]);
  React.useEffect(
    () => () => {
      if (origin.current?.isConnected) origin.current.focus();
    },
    [],
  );
  return (
    <dialog
      ref={dialog}
      className="decision-confirmation"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <h2>{title}</h2>
      <div className="decision-confirmation-body">{children}</div>
      <div className="decision-actions">
        <Button autoFocus disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} disabled={busy} onClick={confirm}>
          Confirm {title.toLowerCase()}
        </Button>
      </div>
    </dialog>
  );
}
