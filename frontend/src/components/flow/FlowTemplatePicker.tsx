'use client';

import React, { useMemo, useState } from 'react';
import { ChevronRight, CalendarClock, Footprints } from 'lucide-react';
import type { FlowTemplateInfo } from '@/api/client';
import { INDUSTRIES, industryFeatures } from '@/lib/terms';
import SeatMap from '@/components/rooms/SeatMap';
import styles from './FlowTemplatePicker.module.css';

type Template = FlowTemplateInfo;

/** Services grouped by how many steps they are from the first point of contact. */
export function flowStages(t: { services: { name: string }[]; flows: Record<string, string[]>; defaultService: string }): string[][] {
  const depth = new Map<string, number>([[t.defaultService, 0]]);
  const queue = [t.defaultService];
  while (queue.length) {
    const from = queue.shift()!;
    for (const to of t.flows[from] ?? []) {
      if (!depth.has(to)) {
        depth.set(to, depth.get(from)! + 1);
        queue.push(to);
      }
    }
  }
  const stages: string[][] = [];
  for (const s of t.services) {
    const d = depth.get(s.name) ?? Math.max(0, ...depth.values()) + 1;
    (stages[d] ??= []).push(s.name);
  }
  return stages.filter(Boolean);
}

const BOOKING_LABEL = {
  WALK_IN: { text: 'Join now', icon: Footprints },
  APPOINTMENT: { text: 'Book a time', icon: CalendarClock },
  BOTH: { text: 'Join now or book', icon: CalendarClock },
} as const;

/** A preview of the flow: columns of steps, left to right, with what follows each. */
export function FlowPreview({ template }: { template: Template }) {
  const stages = useMemo(() => flowStages(template), [template]);
  const byName = useMemo(() => new Map(template.services.map((s) => [s.name, s])), [template]);
  return (
    <div className={styles.preview} aria-label={`${template.name} flow`}>
      {stages.map((names, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronRight className={styles.arrow} size={20} aria-hidden="true" />}
          <div className={styles.stage}>
            <span className={styles.stageLabel}>{i === 0 ? 'Start' : `Then`}</span>
            {names.map((name) => {
              const svc = byName.get(name)!;
              const next = template.flows[name] ?? [];
              const Booking = BOOKING_LABEL[svc.bookingMode];
              return (
                <div key={name} className={styles.node}>
                  <strong>{name}</strong>
                  <span className={styles.nodeDesc}>{svc.description}</span>
                  <span className={styles.tags}>
                    <span className={styles.tag}>
                      <Booking.icon size={12} aria-hidden="true" /> {Booking.text}
                    </span>
                    <span className={styles.tag}>~{svc.slotDuration} min</span>
                    {svc.requiresClearance && <span className={styles.tag}>waits for payment</span>}
                  </span>
                  <span className={styles.next}>{next.length ? `Next: ${next.join(', ')}` : 'Last step'}</span>
                </div>
              );
            })}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

/** The rooms and floor plans a template lays out, drawn the way the booking page will show them. */
export function RoomsPreview({ template, industry }: { template: Template; industry?: string | null }) {
  const rooms = template.rooms ?? [];
  const features = industryFeatures(industry);
  if (!rooms.length) return null;
  if (!features.tables) {
    return <p className={styles.lead}>This template also lays out tables, which aren’t used for your kind of business, so only the services are added.</p>;
  }
  return (
    <div className={styles.rooms}>
      <h4>Also sets up {rooms.length === 1 ? 'a room' : `${rooms.length} rooms`} with a floor plan</h4>
      <p className={styles.lead}>You can rearrange everything afterwards in the floor-plan designer, and upload a picture of your real room behind it.</p>
      <div className={styles.roomGrid}>
        {rooms.map((r) => {
          const seats = r.tables.reduce((n, t) => n + t.seats, 0);
          return (
            <figure key={r.name} className={styles.room}>
              <SeatMap
                layout={{ width: r.layoutWidth, height: r.layoutHeight, imageUrl: null }}
                tables={r.tables.map((t) => ({ ...t, id: t.name, status: 'free' as const }))}
                maxHeight={180}
              />
              <figcaption>
                <strong>{r.name}</strong> · {r.tables.length} {r.tables.length === 1 ? 'table' : 'tables'} · {seats} seats
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}

interface PickerProps {
  templates: Template[];
  /** The signed-in organisation's industry; its templates are shown first. */
  industry?: string | null;
  locationName: string;
  applying: boolean;
  result: string;
  onApply: (templateId: string) => void;
  onClose: () => void;
}

export default function FlowTemplatePicker({ templates, industry, locationName, applying, result, onApply, onClose }: PickerProps) {
  const [filter, setFilter] = useState<string>(industry && industry !== 'OTHER' ? industry : 'ALL');
  const shown = useMemo(() => {
    const list = filter === 'ALL' ? templates : templates.filter((t) => t.industries.includes(filter));
    // Templates made for the chosen industry before general ones.
    return [...list].sort((a, b) => Number(b.industries[0] === filter) - Number(a.industries[0] === filter));
  }, [templates, filter]);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = shown.find((t) => t.id === openId) ?? shown[0];

  return (
    <div className={styles.picker}>
      <h2 id="template-title">Start from a template</h2>
      <p className={styles.lead}>
        Pick your kind of business to preview how people move through it, then apply it to {locationName}. Services that already exist here with the same
        name are reused; nothing is removed, and you can change everything afterwards.
      </p>

      <div className={styles.chips} role="tablist" aria-label="Industry">
        <button type="button" role="tab" aria-selected={filter === 'ALL'} className={filter === 'ALL' ? styles.chipOn : styles.chip} onClick={() => setFilter('ALL')}>
          All
        </button>
        {INDUSTRIES.map((i) => (
          <button
            type="button"
            role="tab"
            key={i.id}
            aria-selected={filter === i.id}
            className={filter === i.id ? styles.chipOn : styles.chip}
            onClick={() => setFilter(i.id)}
          >
            {i.label}
          </button>
        ))}
      </div>

      {templates.length === 0 && <p className={styles.lead}>Loading…</p>}

      <div className={styles.layout}>
        <ul className={styles.list}>
          {shown.map((t) => (
            <li key={t.id}>
              <button type="button" className={open?.id === t.id ? styles.itemOn : styles.item} onClick={() => setOpenId(t.id)}>
                <strong>{t.name}</strong>
                <span>{t.services.length} step{t.services.length === 1 ? '' : 's'}</span>
              </button>
            </li>
          ))}
          {templates.length > 0 && shown.length === 0 && <li className={styles.lead}>Nothing for this industry yet. Try “Single counter” under All.</li>}
        </ul>

        {open && (
          <section className={styles.detail} aria-live="polite">
            <h3>{open.name}</h3>
            <p className={styles.lead}>{open.description}</p>
            <FlowPreview template={open} />
            <RoomsPreview template={open} industry={industry} />
          </section>
        )}
      </div>

      {result && (
        <p className={styles.result} role="status">
          {result}
        </p>
      )}
      <div className={styles.actions}>
        {result ? (
          <button className={styles.primary} onClick={onClose}>Done</button>
        ) : (
          <>
            <button className={styles.secondary} onClick={onClose} disabled={applying}>Cancel</button>
            <button className={styles.primary} onClick={() => open && onApply(open.id)} disabled={applying || !open}>
              {applying ? 'Applying…' : open ? `Apply “${open.name}”` : 'Apply'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
