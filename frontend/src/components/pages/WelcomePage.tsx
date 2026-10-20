'use client';

import QrCode from '@/components/QrCode';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Loader2, Plus, Printer, MonitorPlay, Smartphone, UserPlus, X } from 'lucide-react';
import api from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import { useSubscription } from '@/contexts/SubscriptionContext';
import { apiErrorMessage } from '@/components/auth/AuthShell';
import { INDUSTRIES, termsFor } from '@/lib/terms';

const SUGGESTED_BY_INDUSTRY: Record<string, string[]> = {
  HEALTHCARE: ['Reception', 'Consultation', 'Lab', 'Pharmacy', 'Cashier'],
  RESTAURANT: ['Host stand', 'Takeaway', 'Bar'],
  RETAIL: ['Customer service', 'Collections', 'Returns'],
  BANKING: ['Tellers', 'Customer service', 'Loans'],
  GOVERNMENT: ['Enquiries', 'Applications', 'Collections'],
  EDUCATION: ['Admissions', 'Registry', 'Finance'],
  SALON: ['Hair', 'Nails', 'Treatments'],
  OTHER: ['Front desk', 'Service'],
};
const DAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' }, { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 0, label: 'Sun' },
];

type Result = Awaited<ReturnType<typeof api.quickStart>>;

export default function WelcomePage() {
  const { user, refreshUser } = useAuthContext();
  const [industry, setIndustry] = useState<string>(user?.organization?.industry || '');
  const [currencies, setCurrencies] = useState<string[]>([]);
  const [currency, setCurrency] = useState<string>(user?.organization?.currency || '');
  useEffect(() => {
    api.getPublicCurrencies()
      .then(({ base, currencies: list }) => {
        setCurrencies(list);
        setCurrency((cur) => (cur && list.includes(cur) ? cur : base));
      })
      .catch(() => {});
  }, []);
  const terms = termsFor({ industry: industry || user?.organization?.industry, customerLabel: user?.organization?.customerLabel });
  const SUGGESTED = SUGGESTED_BY_INDUSTRY[industry || 'OTHER'] || SUGGESTED_BY_INDUSTRY.OTHER;
  const { limits, loading: planLoading } = useSubscription();
  // How many services the plan lets this new location have (null = unlimited).
  const maxServices = planLoading || limits.services.limit === null ? null : Math.max(0, limits.services.limit - limits.services.current);
  const [locationName, setLocationName] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('17:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [alreadySetUp, setAlreadySetUp] = useState<{ name: string; publicCode: string | null } | null>(null);

  useEffect(() => {
    api.getOnboardingStatus()
      .then((s) => {
        if (!s.needsSetup && s.firstLocation) setAlreadySetUp(s.firstLocation);
      })
      .catch(() => {});
    if (user?.organizationId) {
      api.getOrganization(user.organizationId).then((org) => setLocationName((n) => n || `${org.name}`)).catch(() => {});
    }
  }, [user?.organizationId]);

  // Keep the default selection inside the plan's limit.
  useEffect(() => {
    if (maxServices !== null) setServices((list) => list.slice(0, Math.max(1, maxServices)));
  }, [maxServices]);

  const atLimit = maxServices !== null && services.length >= maxServices;

  const toggle = (name: string) =>
    setServices((list) => {
      if (list.includes(name)) return list.filter((s) => s !== name);
      if (maxServices !== null && list.length >= maxServices) {
        // Single-service plans: picking another swaps the choice.
        return maxServices === 1 ? [name] : list;
      }
      return [...list, name];
    });

  const addCustom = () => {
    const name = custom.trim();
    if (name && !services.includes(name)) {
      setServices((list) => (maxServices !== null && list.length >= maxServices ? (maxServices === 1 ? [name] : list) : [...list, name]));
    }
    setCustom('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!industry) return setError('Choose what kind of place it is.');
    if (services.length === 0) return setError('Choose at least one service.');
    if (days.length === 0) return setError('Choose the days you’re open.');
    setBusy(true);
    try {
      setResult(await api.quickStart({
        locationName: locationName.trim(),
        services,
        startTime,
        endTime,
        activeDays: [...days].sort().join(','),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        industry: industry || undefined,
        currency: currency || undefined,
      }));
      refreshUser().catch(() => {});
    } catch (err) {
      setError(apiErrorMessage(err, 'Setup didn’t finish. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const live = result ? { name: result.location.name, publicCode: result.location.publicCode } : alreadySetUp;

  if (live) {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const joinUrl = `${origin}/join/${live.publicCode}`;
    return (
      <div className="welcome">
        <div className="welcome-live">
          <div>
            <p className="welcome-kicker"><Check size={16} /> {result ? 'You’re live' : 'Already set up'}</p>
            <h1>{terms.People} can join {live.name} now.</h1>
            <p className="welcome-lede">
              Print this code and put it where people arrive. Scanning it opens the ticket page for your services.
              {result && <> We also added a desk for each service, so your team can start calling straight away.</>}
            </p>
            <div className="welcome-actions">
              <Link href="/admin/qr" className="welcome-action"><Printer size={18} /> Print the QR poster</Link>
              <a href={`/display/${live.publicCode}`} target="_blank" rel="noreferrer" className="welcome-action"><MonitorPlay size={18} /> Open the lobby screen</a>
              <a href={joinUrl} target="_blank" rel="noreferrer" className="welcome-action"><Smartphone size={18} /> Try it as a {terms.person}</a>
              <Link href="/admin/invites" className="welcome-action"><UserPlus size={18} /> Invite your team</Link>
            </div>
            <Link href="/queues" className="authx-submit" style={{ width: 'auto', display: 'inline-flex', padding: '0.875rem 1.5rem', marginTop: '1.5rem' }}>
              Go to today’s queues
            </Link>
          </div>
          <figure className="welcome-qr">
            <QrCode value={joinUrl} size={240} label={`QR code linking to ${joinUrl}`} />
            <figcaption>{joinUrl.replace(/^https?:\/\//, '')}</figcaption>
          </figure>
        </div>
      </div>
    );
  }

  return (
    <div className="welcome">
      <p className="welcome-kicker">Welcome{user?.firstName ? `, ${user.firstName}` : ''}</p>
      <h1>Set up your first queue.</h1>
      <p className="welcome-lede">A few quick choices. You can change all of it later in Setup.</p>

      <form className="welcome-form" onSubmit={submit}>
        <section>
          <h2>What kind of place is it?</h2>
          <div className="welcome-chips" role="radiogroup" aria-label="Kind of organization">
            {INDUSTRIES.map((i) => (
              <button
                key={i.id}
                type="button"
                role="radio"
                aria-checked={industry === i.id}
                className="welcome-chip"
                onClick={() => {
                  setIndustry(i.id);
                  // Swap in suggestions that fit, unless they've added their own.
                  setServices((list) => {
                    const own = list.filter((s) => !Object.values(SUGGESTED_BY_INDUSTRY).flat().includes(s));
                    const picks = (SUGGESTED_BY_INDUSTRY[i.id] || []).slice(0, 2);
                    return [...picks, ...own].slice(0, maxServices ?? 8);
                  });
                }}
              >
                {i.label}
              </button>
            ))}
          </div>
        </section>

        {currencies.length > 1 && (
          <section>
            <h2>Which currency do you charge in?</h2>
            <p className="welcome-help">For your plan, your wallet and any bookings customers pay for. Fixed once money has moved.</p>
            <select id="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
              {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </section>
        )}

        <section>
          <h2>Where do {terms.people} come?</h2>
          <label htmlFor="loc" className="field-label">Location name</label>
          <input id="loc" value={locationName} onChange={(e) => setLocationName(e.target.value)} placeholder="e.g. Main branch" required />
        </section>

        <section>
          <h2>What do they queue for?</h2>
          <p className="welcome-help">
            Each service gets its own queue and a desk to call from.
            {maxServices !== null && (
              <>
                {' '}Your plan includes {maxServices === 1 ? 'one service' : `${maxServices} services`} per location
                {atLimit && <>; <Link href="/admin/billing">see plans</Link> for more</>}.
              </>
            )}
          </p>
          <div className="welcome-chips" role="group" aria-label="Services">
            {[...SUGGESTED, ...services.filter((s) => !SUGGESTED.includes(s))].map((name) => {
              const on = services.includes(name);
              return (
                <button key={name} type="button" className="welcome-chip" aria-pressed={on} onClick={() => toggle(name)}>
                  {on ? <Check size={15} /> : <Plus size={15} />} {name}
                  {on && !SUGGESTED.includes(name) && <X size={13} aria-label={`Remove ${name}`} />}
                </button>
              );
            })}
          </div>
          <div className="welcome-custom">
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }}
              placeholder="Add another, e.g. Dental"
              aria-label="Add another service"
            />
            <button type="button" className="authx-secondary" style={{ width: 'auto' }} onClick={addCustom} disabled={!custom.trim()}>Add</button>
          </div>
        </section>

        <section>
          <h2>When are you open?</h2>
          <div className="welcome-chips" role="group" aria-label="Open days">
            {DAYS.map((d) => (
              <button
                key={d.n}
                type="button"
                className="welcome-chip welcome-day"
                aria-pressed={days.includes(d.n)}
                onClick={() => setDays((list) => (list.includes(d.n) ? list.filter((x) => x !== d.n) : [...list, d.n]))}
              >
                {d.label}
              </button>
            ))}
          </div>
          <div className="welcome-hours">
            <label>Opens <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required /></label>
            <label>Closes <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required /></label>
          </div>
        </section>

        {error && <div className="inline-alert inline-alert-error" role="alert">{error}</div>}

        <div className="welcome-submit">
          <button type="submit" className="authx-submit" disabled={busy} style={{ width: 'auto', padding: '0.9375rem 1.75rem' }}>
            {busy && <Loader2 className="qf-spin" size={18} />}
            {busy ? 'Setting up…' : `Create ${services.length} ${services.length === 1 ? 'queue' : 'queues'}`}
          </button>
          <Link href="/" className="welcome-skip">I’ll do this later</Link>
        </div>
      </form>
    </div>
  );
}
