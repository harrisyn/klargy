'use client';

import React, { useEffect, useState } from 'react';
import api from '@/api/client';
import type { ServicePoint } from '@/types';
import type { WizardServicePoint } from './wizardTypes';

interface ServicePointsDeskPickerProps {
  organizationId: string;
  selected: WizardServicePoint[];
  onChange: (selected: WizardServicePoint[]) => void;
}

export const ServicePointsDeskPicker: React.FC<ServicePointsDeskPickerProps> = ({ organizationId, selected, onChange }) => {
  const [available, setAvailable] = useState<ServicePoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getServicePoints(organizationId)
      .then((points: ServicePoint[]) => setAvailable(points.filter(p => p.isActive)))
      .catch((err: unknown) => console.error('Failed to load service points', err))
      .finally(() => setLoading(false));
  }, [organizationId]);

  const isSelected = (id: string) => selected.some(s => s.servicePointId === id);
  const getCapacity = (id: string) => selected.find(s => s.servicePointId === id)?.capacity;

  const toggle = (point: ServicePoint) => {
    if (isSelected(point.id)) {
      onChange(selected.filter(s => s.servicePointId !== point.id));
    } else {
      onChange([...selected, {
        servicePointId: point.id,
        name: point.name,
        displayName: point.displayName,
        capacity: point.capacity,
      }]);
    }
  };

  const setCapacity = (id: string, capacity: number) => {
    onChange(selected.map(s => s.servicePointId === id ? { ...s, capacity } : s));
  };

  if (loading) {
    return <p className="picker-hint">Loading service points...</p>;
  }

  if (available.length === 0) {
    return (
      <p className="picker-hint">
        No service points defined yet. Create some on the{' '}
        <a href="/admin/service-points" target="_blank" rel="noreferrer">Service Points page</a>{' '}
        first, then come back here.
      </p>
    );
  }

  return (
    <div className="desk-picker">
      {available.map(point => (
        <div key={point.id} className={`desk-picker-row ${isSelected(point.id) ? 'selected' : ''}`}>
          <label className="desk-picker-checkbox">
            <input type="checkbox" checked={isSelected(point.id)} onChange={() => toggle(point)} />
            <span>{point.displayName || point.name}</span>
            <span className="desk-picker-type">{point.type}</span>
          </label>
          {isSelected(point.id) && (
            <div className="desk-picker-capacity">
              <label>Desks</label>
              <input
                type="number"
                min={1}
                value={getCapacity(point.id) ?? point.capacity}
                onChange={e => setCapacity(point.id, Math.max(1, parseInt(e.target.value, 10) || 1))}
              />
            </div>
          )}
        </div>
      ))}
      <style jsx>{`
        .picker-hint {
          font-size: 0.875rem;
          color: #6b7280;
        }
        .desk-picker {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .desk-picker-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.75rem 1rem;
          border: 1px solid #e5e7eb;
          border-radius: 10px;
        }
        .desk-picker-row.selected {
          border-color: var(--primary);
          background: rgba(15, 159, 164, 0.06);
        }
        .desk-picker-checkbox {
          display: flex;
          align-items: center;
          gap: 0.625rem;
          font-weight: 500;
          cursor: pointer;
        }
        .desk-picker-type {
          font-size: 0.7rem;
          color: #6b7280;
          letter-spacing: 0.04em;
        }
        .desk-picker-capacity {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .desk-picker-capacity label {
          font-size: 0.75rem;
          color: #6b7280;
        }
        .desk-picker-capacity input {
          width: 56px;
          padding: 0.375rem 0.5rem;
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          text-align: center;
        }
      `}</style>
    </div>
  );
};

export default ServicePointsDeskPicker;
