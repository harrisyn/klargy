'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { BrandLogo, BrandMark } from '@/components/brand/BrandLogo';
import { APP_NAME } from '@/lib/appConfig';

interface AuthLayoutProps {
  /** Org identity when the page is on a tenant's own address. */
  orgName?: string | null;
  logoUrl?: string | null;
  accentColor?: string | null;
  /** Big line in the side panel. Defaults to a time-of-day greeting. */
  panelTitle?: React.ReactNode;
  panelText?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

function greeting(hour: number) {
  if (hour < 12) return 'Good morning.';
  if (hour < 18) return 'Good afternoon.';
  return 'Good evening.';
}

/**
 * Split layout for sign-in, sign-up and account pages: an ink side panel
 * carrying the organization's identity, and the form on paper. Collapses to a
 * header strip on small screens.
 */
export default function AuthLayout({ orgName, logoUrl, accentColor, panelTitle, panelText, children, footer }: AuthLayoutProps) {
  const [hello, setHello] = useState('');
  useEffect(() => setHello(greeting(new Date().getHours())), []);

  return (
    <div className="authx" style={accentColor ? ({ ['--authx-accent' as string]: accentColor } as React.CSSProperties) : undefined}>
      <aside className="authx-panel">
        <Link href="/" className="authx-brand" aria-label={orgName ? undefined : `${APP_NAME} home`}>
          {orgName || logoUrl ? (
            <>
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt="" className="authx-logo" />
              ) : (
                <BrandMark size={32} />
              )}
              <span>{orgName || APP_NAME}</span>
            </>
          ) : (
            <BrandLogo height={36} surface="dark" />
          )}
        </Link>
        <div className="authx-panel-body">
          <p className="authx-panel-title">{panelTitle ?? hello}</p>
          {panelText && <p className="authx-panel-text">{panelText}</p>}
        </div>
        <p className="authx-panel-foot">
          {orgName ? <>Powered by {APP_NAME}</> : <>Queue management for clinics and service counters</>}
        </p>
      </aside>
      <main className="authx-main">
        <div className="authx-form">{children}</div>
        {footer && <div className="authx-footer">{footer}</div>}
        <nav className="authx-legal" aria-label="Legal">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </main>
    </div>
  );
}
