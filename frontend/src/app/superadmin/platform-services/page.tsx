'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { ServicePanel } from '@/components/platform/ServicePanel';
import { AREAS, SERVICES, SOURCES, serviceById, type Service, type ServiceState, type SourceKey } from '@/components/platform/registry';
import '@/components/platform/platform.css';

const SOURCE_KEYS = Object.keys(SOURCES) as SourceKey[];
const EMPTY: ServiceState = { configured: false, isActive: false, values: {}, secretsMasked: {} };

/** Everything the platform admin sets up: one grid of tiles, settings open beside it. */
function PlatformServices() {
  const router = useRouter();
  const params = useSearchParams();
  const [data, setData] = useState<Partial<Record<SourceKey, unknown>>>({});
  const [failed, setFailed] = useState<SourceKey[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (keys: SourceKey[]) => {
    const results = await Promise.allSettled(keys.map((k) => SOURCES[k]()));
    setData((prev) => {
      const next = { ...prev };
      results.forEach((r, i) => { if (r.status === 'fulfilled') next[keys[i]] = r.value; });
      return next;
    });
    setFailed((prev) => [...prev.filter((k) => !keys.includes(k)), ...keys.filter((_, i) => results[i].status === 'rejected')]);
  }, []);

  useEffect(() => {
    load(SOURCE_KEYS).finally(() => setLoading(false));
  }, [load]);

  const states = useMemo(() => {
    const out: Record<string, ServiceState> = {};
    for (const s of SERVICES) {
      try {
        out[s.id] = data[s.source] === undefined ? EMPTY : s.state(data[s.source]);
      } catch {
        out[s.id] = EMPTY;
      }
    }
    return out;
  }, [data]);

  const selected: Service = serviceById(params?.get('tile')) || SERVICES[0];
  const select = (id: string) => router.replace(`/superadmin/platform-services?tile=${encodeURIComponent(id)}`, { scroll: false });

  return (
    <>
      <PageHeader title="Platform services" subtitle="The providers and prices behind messaging, AI, storage, payments and add-ons. Pick a tile to change its settings." />
      {failed.length > 0 && <div className="ps-banner" role="alert">Some settings couldn’t be loaded ({failed.join(', ')}). Reload to try again.</div>}

      <div className="ps-layout">
        <div className="ps-grid-col">
          {AREAS.map((area) => {
            const inArea = SERVICES.filter((s) => s.area === area.id);
            const groups = [...new Set(inArea.map((s) => s.group))];
            return (
              <section key={area.id} className="ps-area" aria-labelledby={`area-${area.id}`}>
                <h2 id={`area-${area.id}`} className="ps-area-title">{area.title}</h2>
                <p className="ps-area-blurb">{area.blurb}</p>
                {groups.map((group) => (
                  <div key={group} className="ps-group">
                    {groups.length > 1 && <h3 className="ps-group-title">{group}</h3>}
                    <div className="ps-tiles">
                      {inArea.filter((s) => s.group === group).map((s) => {
                        const st = states[s.id] || EMPTY;
                        const hasActive = !!s.activeLabel;
                        const status = hasActive ? (st.configured ? (st.isActive ? 'on' : 'saved') : 'none') : st.configured ? 'saved' : 'none';
                        return (
                          <button key={s.id} type="button" className="ps-tile" data-selected={s.id === selected.id} data-status={status} onClick={() => select(s.id)} aria-pressed={s.id === selected.id}>
                            <span className="ps-tile-name">{s.name}</span>
                            <span className="ps-tile-meta">
                              {hasActive && <span className="ps-dot" aria-hidden="true" />}
                              {st.summary || (hasActive ? (st.configured ? (st.isActive ? 'On' : 'Saved, off') : 'Not set up') : 'Not set')}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </section>
            );
          })}
        </div>

        <aside className="ps-side">
          {loading ? (
            <div className="ps-loading"><div className="spinner" /></div>
          ) : (
            <ServicePanel
              key={`${selected.id}:${JSON.stringify(states[selected.id] || EMPTY)}`}
              service={selected}
              state={states[selected.id] || EMPTY}
              onSaved={() => load([selected.source])}
            />
          )}
        </aside>
      </div>
    </>
  );
}

export default function PlatformServicesPage() {
  return (
    <Suspense fallback={<div className="ps-loading"><div className="spinner" /></div>}>
      <PlatformServices />
    </Suspense>
  );
}
