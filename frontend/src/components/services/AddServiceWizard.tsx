'use client';

import React, { useState } from 'react';
import type { Location } from '@/types';
import { initialWizardData, type WizardData } from './wizardTypes';
import { ServicePointsDeskPicker } from './ServicePointsDeskPicker';

interface AddServiceWizardProps {
  organizationId: string;
  locations: Location[];
  onClose: () => void;
  onSubmit: (data: WizardData) => Promise<void>;
}

const STEP_LABELS = ['Basic Info', 'Location(s)', 'Schedule', 'Service Points & Desks', 'Review'];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatDays = (activeDays: string) => activeDays.split(',').map(d => DAY_NAMES[parseInt(d, 10)] || d).join(', ');

export const AddServiceWizard: React.FC<AddServiceWizardProps> = ({ organizationId, locations, onClose, onSubmit }) => {
  const [step, setStep] = useState(0);
  const [data, setData] = useState<WizardData>(initialWizardData);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const update = <K extends keyof WizardData>(key: K, value: WizardData[K]) => {
    setData(prev => ({ ...prev, [key]: value }));
  };

  const toggleDay = (dayIndex: number) => {
    const current = data.activeDays ? data.activeDays.split(',').filter(Boolean) : [];
    const asStrings = current.map(d => d.trim());
    const dayStr = String(dayIndex);
    const next = asStrings.includes(dayStr)
      ? asStrings.filter(d => d !== dayStr)
      : [...asStrings, dayStr];
    next.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    update('activeDays', next.join(','));
  };

  const canProceedFromStep1 = data.name.trim().length > 0;
  const canProceedFromStep2 = data.locationScope === 'all' || !!data.selectedLocationId;

  const handleNext = () => setStep(s => Math.min(s + 1, STEP_LABELS.length - 1));
  const handleBack = () => setStep(s => Math.max(s - 1, 0));

  const handleSubmit = async () => {
    setSubmitting(true);
    setError('');
    try {
      await onSubmit(data);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string; error?: string } } };
      setError(e.response?.data?.message || e.response?.data?.error || 'Failed to create service');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="wizard-overlay" onClick={onClose}>
      <div className="wizard-modal" onClick={e => e.stopPropagation()}>
        <div className="wizard-header">
          <h2>Add Service</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="wizard-steps">
          {STEP_LABELS.map((label, i) => (
            <div key={label} className={`wizard-step-indicator ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}>
              <span className="step-number">{i + 1}</span>
              <span className="step-label">{label}</span>
            </div>
          ))}
        </div>

        <div className="wizard-body">
          {error && <div className="wizard-error">{error}</div>}

          {step === 0 && (
            <div className="wizard-step-content">
              <div className="form-group">
                <label>Service Name *</label>
                <input
                  type="text"
                  value={data.name}
                  onChange={e => update('name', e.target.value)}
                  placeholder="e.g., General Consultation"
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={data.description}
                  onChange={e => update('description', e.target.value)}
                  rows={3}
                  placeholder="Describe the service..."
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Type</label>
                  <select value={data.type} onChange={e => update('type', e.target.value as WizardData['type'])}>
                    <option value="GENERAL">General (First come, first served)</option>
                    <option value="INDIVIDUAL">Individual (Appointment-based)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Display Mode</label>
                  <select value={data.displayMode} onChange={e => update('displayMode', e.target.value as WizardData['displayMode'])}>
                    <option value="">Use organization default</option>
                    <option value="TICKET_ONLY">Ticket number only</option>
                    <option value="NAME_AND_TICKET">Name and ticket</option>
                    <option value="FULL_INFO">Full info</option>
                  </select>
                </div>
              </div>
              <div className="form-group checkbox-group">
                <label>
                  <input type="checkbox" checked={data.requiresName} onChange={e => update('requiresName', e.target.checked)} />
                  Require customer name to join
                </label>
                <label>
                  <input type="checkbox" checked={data.requiresPhone} onChange={e => update('requiresPhone', e.target.checked)} />
                  Require phone number to join
                </label>
                <label>
                  <input type="checkbox" checked={data.allowAnonymous} onChange={e => update('allowAnonymous', e.target.checked)} />
                  Allow anonymous ticket (no info required)
                </label>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="wizard-step-content">
              <div className="location-scope-choice">
                <button
                  type="button"
                  className={`scope-option ${data.locationScope === 'specific' ? 'selected' : ''}`}
                  onClick={() => update('locationScope', 'specific')}
                >
                  <strong>Specific location</strong>
                  <span>Create this service at one location</span>
                </button>
                <button
                  type="button"
                  className={`scope-option ${data.locationScope === 'all' ? 'selected' : ''}`}
                  onClick={() => update('locationScope', 'all')}
                >
                  <strong>All locations</strong>
                  <span>Create this service at every location in your organization ({locations.length})</span>
                </button>
              </div>

              {data.locationScope === 'specific' && (
                <div className="form-group">
                  <label>Location *</label>
                  <select value={data.selectedLocationId} onChange={e => update('selectedLocationId', e.target.value)}>
                    <option value="">Select a location...</option>
                    {locations.map(loc => (
                      <option key={loc.id} value={loc.id}>{loc.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {data.locationScope === 'all' && (
                <p className="scope-hint">
                  This service will be created identically at all {locations.length} location{locations.length === 1 ? '' : 's'}.
                  Each copy can be edited independently afterward.
                </p>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="wizard-step-content">
              <div className="form-row">
                <div className="form-group">
                  <label>Slot Duration (minutes)</label>
                  <input type="number" min={5} value={data.slotDuration} onChange={e => update('slotDuration', parseInt(e.target.value, 10) || 15)} />
                </div>
                <div className="form-group">
                  <label>Concurrent Limit</label>
                  <input type="number" min={1} value={data.concurrentLimit} onChange={e => update('concurrentLimit', parseInt(e.target.value, 10) || 1)} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Start Time</label>
                  <input type="time" value={data.startTime} onChange={e => update('startTime', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>End Time</label>
                  <input type="time" value={data.endTime} onChange={e => update('endTime', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label>Active Days</label>
                <div className="day-picker">
                  {DAY_NAMES.map((label, i) => {
                    const active = data.activeDays.split(',').map(d => d.trim()).includes(String(i));
                    return (
                      <button
                        key={label}
                        type="button"
                        className={`day-btn ${active ? 'selected' : ''}`}
                        onClick={() => toggleDay(i)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="form-group checkbox-group">
                <label>
                  <input type="checkbox" checked={data.isActive} onChange={e => update('isActive', e.target.checked)} />
                  Open: people can join this service&apos;s queue
                </label>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="wizard-step-content">
              <p className="scope-hint">
                Pick which service points (desks/counters) can serve this service, and how many desks each provides.
                {data.locationScope === 'all' && ' This same assignment is applied at every selected location.'}
              </p>
              <ServicePointsDeskPicker
                organizationId={organizationId}
                selected={data.servicePoints}
                onChange={sps => update('servicePoints', sps)}
              />
            </div>
          )}

          {step === 4 && (
            <div className="wizard-step-content">
              <div className="review-section">
                <h3>{data.name}</h3>
                {data.description && <p className="review-desc">{data.description}</p>}
                <div className="review-grid">
                  <div><span>Type</span><strong>{data.type}</strong></div>
                  <div><span>Hours</span><strong>{data.startTime} - {data.endTime}</strong></div>
                  <div><span>Days</span><strong>{formatDays(data.activeDays)}</strong></div>
                  <div><span>Slot Duration</span><strong>{data.slotDuration} min</strong></div>
                </div>
              </div>
              <div className="review-section">
                <h4>Location(s)</h4>
                <p>
                  {data.locationScope === 'all'
                    ? `All ${locations.length} location${locations.length === 1 ? '' : 's'} in your organization`
                    : locations.find(l => l.id === data.selectedLocationId)?.name || 'None selected'}
                </p>
              </div>
              <div className="review-section">
                <h4>Service Points & Desks</h4>
                {data.servicePoints.length === 0 ? (
                  <p className="review-empty">None assigned yet — you can add these after creating the service.</p>
                ) : (
                  <ul className="review-list">
                    {data.servicePoints.map(sp => (
                      <li key={sp.servicePointId}>{sp.displayName || sp.name} — {sp.capacity} desk{sp.capacity === 1 ? '' : 's'}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="wizard-footer">
          {step > 0 && <button className="btn-secondary" onClick={handleBack}>Back</button>}
          <div className="wizard-footer-spacer" />
          {step === 0 && <button className="btn-primary" disabled={!canProceedFromStep1} onClick={handleNext}>Next</button>}
          {step === 1 && <button className="btn-primary" disabled={!canProceedFromStep2} onClick={handleNext}>Next</button>}
          {(step === 2 || step === 3) && <button className="btn-primary" onClick={handleNext}>Next</button>}
          {step === STEP_LABELS.length - 1 && (
            <button className="btn-primary" disabled={submitting} onClick={handleSubmit}>
              {submitting ? 'Creating...' : 'Create Service'}
            </button>
          )}
        </div>
      </div>

      <style jsx>{`
        .wizard-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 1rem;
        }
        .wizard-modal {
          background: white;
          border-radius: 16px;
          width: 100%;
          max-width: 640px;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .wizard-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1.25rem 1.5rem;
          border-bottom: 1px solid #e5e7eb;
        }
        .wizard-header h2 {
          margin: 0;
          font-size: 1.25rem;
        }
        .close-btn {
          background: none;
          border: none;
          font-size: 1.5rem;
          color: #9ca3af;
          cursor: pointer;
          line-height: 1;
        }
        .wizard-steps {
          display: flex;
          padding: 1rem 1.5rem;
          gap: 0.5rem;
          border-bottom: 1px solid #e5e7eb;
          overflow-x: auto;
        }
        .wizard-step-indicator {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          font-size: 0.75rem;
          color: #9ca3af;
          white-space: nowrap;
        }
        .wizard-step-indicator.active {
          color: var(--primary);
          font-weight: 600;
        }
        .wizard-step-indicator.done {
          color: #16a34a;
        }
        .step-number {
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: #f3f4f6;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.7rem;
        }
        .wizard-step-indicator.active .step-number {
          background: var(--primary);
          color: white;
        }
        .wizard-step-indicator.done .step-number {
          background: #dcfce7;
          color: #16a34a;
        }
        .wizard-body {
          padding: 1.5rem;
          overflow-y: auto;
          flex: 1;
        }
        .wizard-error {
          padding: 0.75rem 1rem;
          background: #fef2f2;
          border: 1px solid #fecaca;
          color: #dc2626;
          border-radius: 8px;
          margin-bottom: 1rem;
          font-size: 0.875rem;
        }
        .form-group {
          margin-bottom: 1.25rem;
        }
        .form-group label {
          display: block;
          font-size: 0.85rem;
          font-weight: 600;
          color: #374151;
          margin-bottom: 0.5rem;
        }
        .form-group input[type="text"],
        .form-group input[type="time"],
        .form-group input[type="number"],
        .form-group select,
        .form-group textarea {
          width: 100%;
          padding: 0.75rem 1rem;
          border: 1px solid #e5e7eb;
          border-radius: 10px;
          font-size: 0.95rem;
          background: #f9fafb;
          color: #111827;
        }
        .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1.25rem;
        }
        .day-picker {
          display: flex;
          gap: 0.5rem;
        }
        .day-btn {
          flex: 1;
          padding: 0.6rem 0;
          border: 2px solid #e5e7eb;
          border-radius: 8px;
          background: white;
          color: #6b7280;
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
        }
        .day-btn.selected {
          border-color: var(--primary);
          background: rgba(15, 159, 164, 0.1);
          color: var(--primary);
        }
        .checkbox-group label {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-weight: 400;
          margin-bottom: 0.5rem;
        }
        .location-scope-choice {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1rem;
          margin-bottom: 1.25rem;
        }
        .scope-option {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          padding: 1rem;
          border: 2px solid #e5e7eb;
          border-radius: 12px;
          background: white;
          cursor: pointer;
          text-align: left;
        }
        .scope-option.selected {
          border-color: var(--primary);
          background: rgba(15, 159, 164, 0.06);
        }
        .scope-option span {
          font-size: 0.8rem;
          color: #6b7280;
        }
        .scope-hint {
          font-size: 0.875rem;
          color: #6b7280;
          background: #f9fafb;
          padding: 0.75rem 1rem;
          border-radius: 8px;
        }
        .wizard-footer {
          display: flex;
          align-items: center;
          padding: 1.25rem 1.5rem;
          border-top: 1px solid #e5e7eb;
          gap: 0.75rem;
        }
        .wizard-footer-spacer {
          flex: 1;
        }
        .btn-primary {
          padding: 0.75rem 1.5rem;
          background: var(--primary);
          color: white;
          border: none;
          border-radius: 10px;
          font-weight: 600;
          cursor: pointer;
        }
        .btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .btn-secondary {
          padding: 0.75rem 1.5rem;
          background: #f1f5f9;
          color: #64748b;
          border: none;
          border-radius: 10px;
          font-weight: 600;
          cursor: pointer;
        }
        .review-section {
          margin-bottom: 1.5rem;
        }
        .review-section h3 {
          margin: 0 0 0.25rem;
        }
        .review-section h4 {
          margin: 0 0 0.5rem;
          font-size: 0.9rem;
          color: #374151;
        }
        .review-desc {
          color: #6b7280;
          margin: 0 0 0.75rem;
        }
        .review-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 0.75rem;
        }
        .review-grid div {
          display: flex;
          flex-direction: column;
          gap: 0.125rem;
          font-size: 0.85rem;
        }
        .review-grid span {
          color: #6b7280;
          font-size: 0.75rem;
        }
        .review-list {
          margin: 0;
          padding-left: 1.25rem;
          font-size: 0.875rem;
          color: #374151;
        }
        .review-empty {
          font-size: 0.875rem;
          color: #6b7280;
        }
      `}</style>
    </div>
  );
};

export default AddServiceWizard;
