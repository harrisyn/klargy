'use client';

import React, { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button, Switch } from '@/components/ui';
import { toast, errorMessage } from '@/lib/toast';
import type { Service, ServiceState } from './registry';

/** The settings form for one tile, built from the service's field list. */
export function ServicePanel({ service, state, onSaved }: { service: Service; state: ServiceState; onSaved: () => Promise<void> | void }) {
  const [values, setValues] = useState<Record<string, string>>(state.values);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [isActive, setIsActive] = useState(state.isActive);
  const [testInput, setTestInput] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const set = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v }));
  const dirty = useMemo(
    () => isActive !== state.isActive || Object.keys(secrets).some((k) => secrets[k]) || service.fields.some((f) => f.kind !== 'secret' && (values[f.key] ?? '') !== (state.values[f.key] ?? '')),
    [values, secrets, isActive, state, service.fields]
  );

  const save = async () => {
    for (const f of service.fields) {
      if (f.alwaysRequired && !secrets[f.key]) return toast.error(`Enter the ${f.label.toLowerCase()} to save.`);
    }
    setBusy('save');
    setResult(null);
    try {
      await service.save(values, secrets, service.activeLabel ? isActive : true);
      setSecrets({});
      toast.success(`${service.name} saved.`);
      await onSaved();
    } catch (err) {
      toast.error(errorMessage(err, 'Couldn’t save.'));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!service.test) return;
    if (service.testInput && !service.testInput.optional && !testInput.trim()) return toast.error(`Enter ${service.testInput.label.toLowerCase()}.`);
    setBusy('test');
    setResult(null);
    try {
      setResult({ ok: true, text: await service.test(values, secrets, testInput) });
    } catch (err) {
      setResult({ ok: false, text: errorMessage(err, err instanceof Error && err.message ? err.message : 'The test failed.') });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="ps-panel" aria-label={`${service.name} settings`}>
      <header className="ps-panel-head">
        <h2>{service.name}</h2>
        {service.activeLabel && state.configured && <span className={`ps-pill ${state.isActive ? 'on' : ''}`}>{state.isActive ? 'On' : 'Off'}</span>}
      </header>
      <p className="ps-note">{service.note}</p>

      <div className="ps-fields">
        {service.fields.map((f) => {
          const id = `${service.id}-${f.key}`;
          if (f.kind === 'toggle') {
            return (
              <div key={f.key} className="ps-field ps-wide">
                <Switch label={f.label} checked={values[f.key] === 'true'} onChange={(e) => set(f.key, String(e.target.checked))} />
                {f.hint && <small>{f.hint}</small>}
              </div>
            );
          }
          if (f.kind === 'secret') {
            const masked = state.secretsMasked[f.key];
            return (
              <label key={f.key} className="ps-field" htmlFor={id}>
                <span>{f.label}</span>
                <input id={id} type="password" value={secrets[f.key] || ''} onChange={(e) => setSecrets((p) => ({ ...p, [f.key]: e.target.value }))} placeholder={masked || f.placeholder || ''} autoComplete="new-password" />
                <small>{masked && !f.alwaysRequired ? 'Leave blank to keep the saved one.' : f.hint}</small>
              </label>
            );
          }
          const list = f.suggestions ? `${id}-list` : undefined;
          return (
            <label key={f.key} className="ps-field" htmlFor={id}>
              <span>{f.label}</span>
              <input id={id} type={f.kind === 'number' ? 'number' : 'text'} step={f.kind === 'number' ? 'any' : undefined} min={f.kind === 'number' ? 0 : undefined} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} list={list} autoComplete="off" />
              {list && <datalist id={list}>{f.suggestions!.map((m) => <option key={m} value={m} />)}</datalist>}
              {f.hint && <small>{f.hint}</small>}
            </label>
          );
        })}
      </div>

      {service.activeLabel && (
        <div className="ps-switch">
          <Switch label={service.activeLabel} checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        </div>
      )}

      <div className="ps-actions">
        <Button onClick={save} disabled={busy !== null || !dirty}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
        {service.test && state.configured && (
          <>
            {service.testInput && (
              <input className="ps-test-input" value={testInput} onChange={(e) => setTestInput(e.target.value)} placeholder={service.testInput.placeholder} aria-label={service.testInput.label} />
            )}
            <Button variant="secondary" onClick={test} disabled={busy !== null}>
              {busy === 'test' ? <Loader2 size={14} className="spin" aria-hidden="true" /> : null} {service.testLabel || 'Test'}
            </Button>
          </>
        )}
      </div>
      {result && <p className={`ps-result ${result.ok ? 'ok' : 'bad'}`} role="status">{result.text}</p>}
    </section>
  );
}
