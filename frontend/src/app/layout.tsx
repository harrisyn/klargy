import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Bricolage_Grotesque, Public_Sans } from 'next/font/google';
import './globals.css';
import './settings.css';
import './desk.css';
import { AuthProvider } from '@/contexts/AuthContext';
import { SubscriptionProvider } from '@/contexts/SubscriptionContext';
import ToastHost from '@/components/ui/ToastHost';
import DialogHost from '@/components/ui/DialogHost';
import { readRuntimeConfigFromEnv } from '@/lib/runtimeConfig';

// Two families: Public Sans for UI/body (plain, highly legible - civic and
// healthcare signage heritage) and Bricolage Grotesque for headlines and big
// ticket numbers, where the type itself carries the personality.
const bodyFont = Public_Sans({ subsets: ['latin'], variable: '--font-body', display: 'swap' });
const displayFont = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-headline', display: 'swap', axes: ['opsz', 'wdth'] });

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const { appName } = readRuntimeConfigFromEnv();
  return {
    title: appName,
    description: `Professional queue management system for healthcare and services, powered by ${appName}`,
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Render per request so the runtime config below reflects the live env.
  await connection();
  const runtimeConfig = JSON.stringify(readRuntimeConfigFromEnv()).replace(/</g, '\\u003c');
  return (
    <html lang="en" className={`${bodyFont.variable} ${displayFont.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `window.__RUNTIME_CONFIG__=${runtimeConfig};` }} />
      </head>
      <body>
        {/*
          Cross-subdomain impersonation handoff. localStorage/sessionStorage
          are per-origin, so a token minted on admin.<domain> can't just be
          read on <slug>.<domain> - it's carried across in the URL fragment
          (never sent to the server, unlike a query string) and applied here,
          synchronously, before React hydrates and AuthProvider's mount
          effect reads localStorage for the first time.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function() {
              try {
                var hash = window.location.hash;
                if (!hash || hash.length < 2) return;
                var params = new URLSearchParams(hash.slice(1));
                var impersonateToken = params.get('impersonate');
                var restoreToken = params.get('restore');
                var sessionToken = params.get('session');
                if (sessionToken) {
                  // New sign-up handed over from the root domain.
                  localStorage.setItem('token', sessionToken);
                  history.replaceState(null, '', window.location.pathname + window.location.search);
                } else if (impersonateToken) {
                  var superToken = params.get('superToken') || '';
                  var orgId = params.get('orgId') || '';
                  var orgName = params.get('orgName') || '';
                  localStorage.setItem('token', impersonateToken);
                  if (superToken) {
                    sessionStorage.setItem('impersonation', JSON.stringify({
                      returnToken: superToken,
                      returnPath: orgId ? ('/superadmin/organizations/' + orgId) : '/superadmin/organizations',
                      orgName: orgName
                    }));
                  }
                  history.replaceState(null, '', window.location.pathname + window.location.search);
                } else if (restoreToken) {
                  localStorage.setItem('token', restoreToken);
                  sessionStorage.removeItem('impersonation');
                  history.replaceState(null, '', window.location.pathname + window.location.search);
                }
              } catch (e) {}
            })();`,
          }}
        />
        <AuthProvider>
          <SubscriptionProvider>
            {children}
            <ToastHost />
            <DialogHost />
          </SubscriptionProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
