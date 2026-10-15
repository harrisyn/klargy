'use client';

import React, { useEffect, useState } from 'react';
import { Copy, Download, ExternalLink, Printer } from 'lucide-react';
import api from '@/api/client';
import { useAuthContext } from '@/contexts/AuthContext';
import { useTerms } from '@/hooks/useTerms';
import Layout from '@/components/Layout';
import { Button, PageHeader } from '@/components/ui';
import QrCode, { qrPng } from '@/components/QrCode';

/**
 * A print-ready poster for each location. The QR opens the join page; the
 * poster explains what happens next so people scan with confidence.
 */

interface LocationRow { id: string; name: string; publicCode?: string | null }

export default function AdminQRPage() {
  const { user } = useAuthContext();
  const terms = useTerms();
  const [locations, setLocations] = useState<LocationRow[] | null>(null);
  const [locationId, setLocationId] = useState('');
  const [org, setOrg] = useState<{ name: string; logoUrl?: string | null; primaryColor?: string | null } | null>(null);
  const [headline, setHeadline] = useState('Join the queue from your phone');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!user?.organizationId) return;
    api.getLocations(user.organizationId)
      .then((locs: LocationRow[]) => {
        const withCode = locs.filter((l) => l.publicCode);
        setLocations(withCode);
        setLocationId(withCode[0]?.id || '');
      })
      .catch(() => setLocations([]));
    api.getOrganization(user.organizationId).then(setOrg).catch(() => {});
  }, [user?.organizationId]);

  const location = locations?.find((l) => l.id === locationId);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const joinUrl = location?.publicCode ? `${origin}/join/${location.publicCode}` : '';
  const shortUrl = joinUrl.replace(/^https?:\/\//, '');
  const accent = org?.primaryColor || '#0f9fa4';

  const download = async () => {
    if (!joinUrl || !location) return;
    const a = document.createElement('a');
    a.href = await qrPng(joinUrl);
    a.download = `qr-${location.publicCode}.png`;
    a.click();
  };

  if (locations && locations.length === 0) {
    return (
      <Layout>
        <PageHeader title="QR codes" subtitle="Print a poster for each location." />
        <div className="panel qr-empty"><p>Add a location first. Each location gets its own code.</p></div>
      </Layout>
    );
  }

  return (
    <Layout>
      <PageHeader
        title="QR codes"
        subtitle="Print a poster for each location. Scanning it opens the page where people join a queue."
        actions={<Button onClick={() => window.print()} disabled={!joinUrl}><Printer size={16} /> Print poster</Button>}
      />

      <div className="qr-layout">
        <aside className="panel qr-controls">
          {locations && locations.length > 1 && (
            <label className="settings-field">
              <span>Location</span>
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
          )}
          <label className="settings-field">
            <span>Headline</span>
            <input value={headline} maxLength={60} onChange={(e) => setHeadline(e.target.value)} />
          </label>

          <div className="qr-link">
            <span>Join link</span>
            <code>{shortUrl || '…'}</code>
            <div className="qr-link-actions">
              <Button variant="secondary" size="sm" disabled={!joinUrl} onClick={() => navigator.clipboard.writeText(joinUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
                <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
              </Button>
              <a className="btn btn-secondary btn-sm" href={joinUrl || undefined} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Try it</a>
            </div>
          </div>

          <Button variant="secondary" onClick={download} disabled={!joinUrl}><Download size={16} /> Download the code as PNG</Button>
          <p className="qr-tip">Put it where people arrive, at eye level. Test it with your own phone before you print a batch.</p>
        </aside>

        <div className="qr-stage">
          <article className="qr-poster" style={{ '--poster-accent': accent } as React.CSSProperties} aria-label="Poster preview">
            <header>
              {org?.logoUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={org.logoUrl} alt={org.name} />
                : <strong>{org?.name}</strong>}
              {location && location.name !== org?.name && <span>{location.name}</span>}
            </header>
            <h2>{headline || 'Join the queue from your phone'}</h2>
            <div className="qr-poster-code">{joinUrl && <QrCode value={joinUrl} size={300} label={`QR code for ${shortUrl}`} />}</div>
            <ol>
              <li><b>1</b>Point your camera at the code</li>
              <li><b>2</b>Choose what you’re here for</li>
              <li><b>3</b>Wait anywhere. We’ll tell you when it’s your turn</li>
            </ol>
            <footer>
              <span>No app needed. Or go to</span>
              <strong>{shortUrl}</strong>
            </footer>
          </article>
          <p className="qr-caption">A4 portrait. {terms.People} who can’t scan can ask at the desk to be added.</p>
        </div>
      </div>
    </Layout>
  );
}
