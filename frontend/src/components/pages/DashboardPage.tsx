'use client';

import { localDay } from '@/lib/localDate';
import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Circle, X } from 'lucide-react';
import api from '@/api/client';
import type { Appointment } from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import { useSubscription } from '@/contexts/SubscriptionContext';
import { useSocket } from '@/hooks/useSocket';
import { useTerms } from '@/hooks/useTerms';
import Layout from '@/components/Layout';
import { PageHeader } from '@/components/ui';
import WaitAlerts from '@/components/ai/WaitAlerts';
import type { DeskInstance } from '@/components/desk/useDesk';
import { deskLabel } from '@/components/desk/useDesk';

/**
 * Today at a location: who's waiting, how long for, who's at which desk,
 * and what's booked. The first thing staff see after signing in.
 */

interface LocationRow { id: string; name: string; publicCode?: string | null }

interface ServiceMetric {
  serviceId: string;
  serviceName: string;
  counts: { total: number; served: number; waiting: number; serving: number; noShows: number };
  waitTime: { average: number; longest: number };
}

interface Detailed {
  services: ServiceMetric[];
  totals: { total: number; served: number; waiting: number; serving: number; noShows: number };
  longestCurrentWait: number;
}

type DeskRow = DeskInstance & { currentlyServing?: { ticketNumber: string; customerName: string } | null };

const mins = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n} min`);
const LOC_KEY = 'qms_dashboard_location';
const CHECKLIST_KEY = 'qms_setup_dismissed';

function SetupChecklist({ location, terms }: { location: LocationRow; terms: ReturnType<typeof useTerms> }) {
  const { limits } = useSubscription();
  const [status, setStatus] = useState<{ desks: number; entries: number } | null>(null);
  const [printed, setPrinted] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(CHECKLIST_KEY) === '1');
      setPrinted(localStorage.getItem('qms_setup_printed') === '1');
    } catch { setDismissed(false); }
    api.getOnboardingStatus().then(setStatus).catch(() => {});
  }, []);

  if (dismissed || !status) return null;
  const steps = [
    { done: status.desks > 0, label: 'Add a desk or room to call from', href: '/admin/service-points' },
    { done: printed, label: 'Print the QR poster for the entrance', href: '/admin/qr', onClick: () => { try { localStorage.setItem('qms_setup_printed', '1'); } catch { /* ignore */ } } },
    { done: status.entries > 0, label: `Join the queue yourself, as a ${terms.person} would`, href: location.publicCode ? `/join/${location.publicCode}` : '/admin/qr', external: true },
    { done: (limits.users.current || 0) > 1, label: 'Invite the rest of your team', href: '/admin/invites' },
  ];
  if (steps.every((s) => s.done)) return null;

  return (
    <section className="panel today-setup" aria-label="Finish setting up">
      <div className="today-setup-head">
        <h2>Finish setting up</h2>
        <span>{steps.filter((s) => s.done).length} of {steps.length} done</span>
        <button type="button" aria-label="Hide setup steps" onClick={() => { try { localStorage.setItem(CHECKLIST_KEY, '1'); } catch { /* ignore */ } setDismissed(true); }}><X size={16} /></button>
      </div>
      <ol>
        {steps.map((s) => (
          <li key={s.label} data-done={s.done}>
            {s.done ? <Check size={16} /> : <Circle size={16} />}
            {s.done ? <span>{s.label}</span> : (
              <Link href={s.href} onClick={s.onClick} target={s.external ? '_blank' : undefined}>{s.label}</Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function DashboardPage() {
  const { user, isAdmin } = useAuthContext();
  const terms = useTerms();
  const { joinLocation, onQueueUpdated, onEntryStatusChanged } = useSocket();
  const [locations, setLocations] = useState<LocationRow[] | null>(null);
  const [locationId, setLocationId] = useState('');
  const [metrics, setMetrics] = useState<Detailed | null>(null);
  const [desks, setDesks] = useState<DeskRow[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    if (!user?.organizationId) return;
    api.getLocations(user.organizationId).then((locs: LocationRow[]) => {
      setLocations(locs);
      let saved: string | null = null;
      try { saved = localStorage.getItem(LOC_KEY); } catch { /* ignore */ }
      setLocationId((locs.find((l) => l.id === saved) || locs[0])?.id || '');
    }).catch(() => { setLocations([]); setProblem('Couldn’t load your locations.'); });
  }, [user?.organizationId]);

  const load = useCallback(async (id: string) => {
    const today = localDay();
    const [m, d, a] = await Promise.all([
      api.getDetailedAnalytics(id).catch(() => null),
      api.getLocationInstances(id).catch(() => []),
      api.getAppointments({ locationId: id, date: today }).catch(() => []),
    ]);
    setMetrics(m);
    setDesks(d);
    setAppointments(a);
  }, []);

  useEffect(() => {
    if (!locationId) return;
    try { localStorage.setItem(LOC_KEY, locationId); } catch { /* ignore */ }
    load(locationId);
    joinLocation(locationId);
    const refresh = () => load(locationId);
    const a = onQueueUpdated(refresh);
    const b = onEntryStatusChanged(refresh);
    const t = setInterval(refresh, 60000);
    return () => { a(); b(); clearInterval(t); };
  }, [locationId, load, joinLocation, onQueueUpdated, onEntryStatusChanged]);

  const location = locations?.find((l) => l.id === locationId);
  const today = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const served = metrics?.services.filter((s) => s.counts.served > 0) || [];
  const avgWait = served.length ? Math.round(served.reduce((n, s) => n + s.waitTime.average * s.counts.served, 0) / served.reduce((n, s) => n + s.counts.served, 0)) : 0;
  const upcoming = appointments
    .filter((a) => a.status !== 'CANCELLED' && a.status !== 'COMPLETED' && a.status !== 'NO_SHOW')
    .sort((x, y) => x.startTime.localeCompare(y.startTime));

  if (locations && locations.length === 0) {
    return (
      <Layout>
        <PageHeader title="Today" subtitle={today} />
        <div className="panel today-empty">
          <h2>Set up your first queue</h2>
          <p>Add a location and a service, and {terms.people} can start joining from a QR code.</p>
          {isAdmin && <Link className="btn btn-primary" href="/welcome">Start setup</Link>}
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <PageHeader
        title="Today"
        subtitle={`${today}${location ? ` · ${location.name}` : ''}`}
        actions={
          <div className="today-actions">
            {locations && locations.length > 1 && (
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-label="Location">
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            )}
            <Link className="btn btn-primary" href="/queues">Go to my desk</Link>
          </div>
        }
      />

      {problem && <div className="inline-alert inline-alert-error" role="alert">{problem}</div>}
      {isAdmin && location && <SetupChecklist location={location} terms={terms} />}
      {locationId && <WaitAlerts locationId={locationId} />}

      <section className="today-numbers" aria-label="Right now">
        <div><b>{metrics ? metrics.totals.waiting : '–'}</b><span>waiting now</span></div>
        <div><b>{metrics ? (metrics.totals.waiting ? mins(metrics.longestCurrentWait) : '–') : '–'}</b><span>longest wait right now</span></div>
        <div><b>{metrics ? metrics.totals.served : '–'}</b><span>{terms.people} served today</span></div>
        <div><b>{metrics && served.length ? mins(avgWait) : '–'}</b><span>average wait today</span></div>
      </section>

      <div className="today-grid">
        <section className="panel today-services">
          <h2>Services</h2>
          {!metrics ? <div className="spinner" /> : metrics.services.length === 0 ? (
            <p className="muted">No services at this location yet.</p>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Service</th><th>Waiting</th><th>Being served</th><th>Served</th><th>Average wait</th><th>Not here</th></tr>
                </thead>
                <tbody>
                  {metrics.services.map((s) => (
                    <tr key={s.serviceId}>
                      <td><strong>{s.serviceName}</strong></td>
                      <td data-hot={s.counts.waiting >= 5}>{s.counts.waiting}</td>
                      <td>{s.counts.serving}</td>
                      <td>{s.counts.served}</td>
                      <td>{s.counts.served ? mins(s.waitTime.average) : '–'}</td>
                      <td>{s.counts.noShows || '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="today-side">
          <section className="panel">
            <h2>Desks</h2>
            {desks.length === 0 ? (
              <p className="muted">No desks yet.{isAdmin && <> <Link href="/admin/service-points">Add one</Link>.</>}</p>
            ) : (
              <ul className="today-desks">
                {desks.map((d) => (
                  <li key={d.id} data-open={d.isOccupied}>
                    <span className="today-dot" aria-hidden="true" />
                    <div>
                      <strong>{deskLabel(d)}</strong>
                      <small>{d.isOccupied && d.occupiedBy ? `${d.occupiedBy.firstName} ${d.occupiedBy.lastName}` : 'Nobody signed in'} · {d.currentService?.name}</small>
                    </div>
                    {d.currentlyServing && <b>{d.currentlyServing.ticketNumber}</b>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <div className="today-panel-head">
              <h2>Appointments today</h2>
              <Link href="/appointments">All</Link>
            </div>
            {upcoming.length === 0 ? (
              <p className="muted">Nothing booked for today.</p>
            ) : (
              <ul className="today-appts">
                {upcoming.slice(0, 6).map((a) => (
                  <li key={a.id}>
                    <time>{new Date(a.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                    <span>{a.user.firstName} {a.user.lastName}</span>
                    <small>{a.status === 'CHECKED_IN' ? 'Checked in' : a.service.name}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </Layout>
  );
}
