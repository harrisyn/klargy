'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import api from '@/api/client';
import type { PatientLookup } from '@/types';

/**
 * The system's record for the person at the desk (Klargy Connect phase 4):
 * who they are and whether their cover is good, as the system says. Shown only
 * when the patient came from a connected EMR. Staff can also check an MR or
 * member number someone gives them.
 */

type Patient = NonNullable<PatientLookup['patient']>;
type Cover = NonNullable<Patient['cover']>;

const FLAG_TEXT: Record<string, string> = {
  has_open_visit: 'Has an open visit',
  outstanding_balance: 'Owes a balance',
};

const formatDate = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

const errorOf = (err: unknown) => {
  const e = err as { response?: { status?: number; data?: { error?: string; code?: string } } };
  return { status: e?.response?.status, code: e?.response?.data?.code, message: e?.response?.data?.error };
};

/** Plain words for the cover check, and whether it needs attention. */
export function coverSummary(cover: Cover): { text: string; tone: 'good' | 'bad' | 'unsure' } {
  const who = [cover.payer, cover.plan].filter(Boolean).join(' · ');
  switch (cover.status) {
    case 'active':
      return { text: `${who}: cover active${cover.expiresOn ? ` until ${formatDate(cover.expiresOn)}` : ''}`, tone: 'good' };
    case 'expired':
      return { text: `${who}: cover expired${cover.expiresOn ? ` on ${formatDate(cover.expiresOn)}` : ''}`, tone: 'bad' };
    case 'inactive':
      return { text: `${who}: cover not active`, tone: 'bad' };
    default:
      return { text: `${who}: cover couldn’t be checked${cover.message ? `. ${cover.message}` : ''}`, tone: 'unsure' };
  }
}

function Verify({ patientRef }: { patientRef?: string }) {
  const [type, setType] = useState<'mrNumber' | 'memberNumber'>('mrNumber');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'good' | 'bad' | 'unsure'; text: string } | null>(null);

  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const found = await api.connectLookup({ identifierType: type, identifier: value.trim() });
      if (!found.matched || !found.patient) setResult({ tone: 'bad', text: 'Not matched: the system has no patient with that number.' });
      else if (patientRef && found.patient.ref && found.patient.ref !== patientRef) {
        setResult({ tone: 'bad', text: `Matched someone else: ${found.patient.displayName || 'another patient'}.` });
      } else setResult({ tone: 'good', text: `Matched${found.patient.displayName ? `: ${found.patient.displayName}` : ''}.` });
    } catch (err) {
      setResult({ tone: 'unsure', text: errorOf(err).message || 'Couldn’t check that number. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="patient-verify" onSubmit={check}>
      <label htmlFor="patient-verify-value">Verify a number</label>
      <div className="patient-verify-row">
        <select aria-label="Kind of number" value={type} onChange={(e) => { setType(e.target.value as typeof type); setResult(null); }}>
          <option value="mrNumber">MR number</option>
          <option value="memberNumber">Member number</option>
        </select>
        <input id="patient-verify-value" value={value} onChange={(e) => { setValue(e.target.value); setResult(null); }} autoComplete="off" />
        <button type="submit" className="desk-btn" disabled={busy || !value.trim()}>
          {busy ? <Loader2 size={15} className="qf-spin" /> : null} Check
        </button>
      </div>
      {result && <p className={`patient-note patient-note-${result.tone}`} role="status">{result.text}</p>}
    </form>
  );
}

export default function PatientCard({ entryId }: { entryId: string }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'hidden' }
    | { kind: 'failed'; message: string }
    | { kind: 'ready'; system: string; lookup: PatientLookup }
  >({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const { system, ...lookup } = await api.getEntryLookup(entryId);
      setState({ kind: 'ready', system, lookup });
    } catch (err) {
      const { status, message } = errorOf(err);
      // Not from a connected EMR, or no lookup set up: nothing to show.
      if (status === 404 || status === 409 || status === 403) setState({ kind: 'hidden' });
      else setState({ kind: 'failed', message: message || 'Couldn’t reach the system.' });
    }
  }, [entryId]);

  // One card per ticket (the desk keys it by entry), so it starts out loading.
  useEffect(() => { load(); }, [load]);
  const retry = () => { setState({ kind: 'loading' }); load(); };

  if (state.kind === 'hidden') return null;
  if (state.kind === 'loading') {
    return <section className="patient-card" aria-busy="true"><p className="patient-muted"><Loader2 size={15} className="qf-spin" /> Getting their record…</p></section>;
  }
  if (state.kind === 'failed') {
    return (
      <section className="patient-card">
        <p className="patient-muted">{state.message}</p>
        <button type="button" className="desk-btn desk-btn-quiet" onClick={retry}><RefreshCw size={14} /> Try again</button>
      </section>
    );
  }

  const p = state.lookup.patient;
  if (!state.lookup.matched || !p) {
    return <section className="patient-card"><p className="patient-muted">{state.system} has no record for this patient.</p></section>;
  }
  const cover = p.cover ? coverSummary(p.cover) : null;
  const facts: [string, string | null | undefined][] = [
    ['MR number', p.mrNumber],
    ['Born', formatDate(p.birthDate)],
    ['Gender', p.gender],
    ['Phone', p.phoneMasked],
  ];

  return (
    <section className="patient-card" aria-label={`Record in ${state.system}`}>
      <header>
        <strong>{p.displayName || p.firstName || 'Patient'}</strong>
        <small>From {state.system}</small>
      </header>
      <dl>
        {facts.filter(([, v]) => v).map(([k, v]) => (
          <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>
        ))}
      </dl>
      {cover ? (
        <p className={`patient-note patient-note-${cover.tone}`}>
          {cover.tone === 'good' ? <CheckCircle2 size={15} /> : cover.tone === 'bad' ? <XCircle size={15} /> : <AlertTriangle size={15} />}
          {cover.text}
        </p>
      ) : (
        <p className="patient-muted">No insurance cover on file.</p>
      )}
      {p.flags && p.flags.length > 0 && (
        <ul className="patient-flags">
          {p.flags.map((f) => <li key={f}>{FLAG_TEXT[f] || f.replace(/_/g, ' ')}</li>)}
        </ul>
      )}
      <Verify patientRef={p.ref} />
    </section>
  );
}
