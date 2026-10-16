'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import { DIALOG_EVENT, type DialogRequest } from '@/lib/dialog';

/** Shows confirmDialog / promptDialog requests one at a time, in order. */
export default function DialogHost() {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const current = queue[0];

  useEffect(() => {
    const onRequest = (e: Event) => setQueue((q) => [...q, (e as CustomEvent<DialogRequest>).detail]);
    window.addEventListener(DIALOG_EVENT, onRequest);
    return () => window.removeEventListener(DIALOG_EVENT, onRequest);
  }, []);

  useEffect(() => {
    if (!current) return;
    setText(current.kind === 'prompt' ? current.defaultValue ?? '' : '');
    const t = setTimeout(() => (current.kind === 'prompt' || current.requireText ? inputRef.current : confirmRef.current)?.focus(), 0);
    return () => clearTimeout(t);
  }, [current]);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') settle(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!current) return null;

  const blocked = current.kind === 'confirm' && !!current.requireText && text.trim() !== current.requireText;

  function settle(ok: boolean) {
    if (!current) return;
    if (current.kind === 'confirm') current.resolve(ok);
    else current.resolve(ok ? text : null);
    setQueue((q) => q.slice(1));
  }

  const danger = current.tone === 'danger';
  const showInput = current.kind === 'prompt' || !!current.requireText;
  const multiline = current.kind === 'prompt' && current.multiline;

  return (
    <Modal
      open
      onClose={() => settle(false)}
      title={current.title}
      maxWidth="460px"
      footer={
        <>
          <Button variant="secondary" onClick={() => settle(false)}>{current.cancelLabel ?? 'Cancel'}</Button>
          <Button
            ref={confirmRef}
            className={danger ? 'btn-danger' : ''}
            disabled={blocked}
            onClick={() => settle(true)}
          >
            {current.confirmLabel ?? (danger ? 'Delete' : 'Confirm')}
          </Button>
        </>
      }
    >
      <form
        className="dialog-body"
        onSubmit={(e) => { e.preventDefault(); if (!blocked) settle(true); }}
      >
        {danger && (
          <span className="dialog-icon" aria-hidden="true"><AlertTriangle size={20} /></span>
        )}
        <div className="dialog-content">
          {current.message && <p className="dialog-message">{current.message}</p>}
          {showInput && (
            <div className="field">
              <label className="field-label" htmlFor="dialog-input">
                {current.kind === 'confirm' ? <>Type <strong>{current.requireText}</strong> to confirm</> : current.label ?? 'Your answer'}
              </label>
              {multiline ? (
                <textarea id="dialog-input" ref={inputRef} rows={3} value={text} placeholder={current.kind === 'prompt' ? current.placeholder : undefined} onChange={(e) => setText(e.target.value)} />
              ) : (
                <input id="dialog-input" ref={inputRef} value={text} autoComplete="off" placeholder={current.kind === 'prompt' ? current.placeholder : undefined} onChange={(e) => setText(e.target.value)} />
              )}
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}
