// Public settings that used to be NEXT_PUBLIC_* build-time constants. They are
// read from the server's environment when the process runs, and the root
// layout hands them to the browser as window.__RUNTIME_CONFIG__ - so one built
// image works for any domain, app name or realtime provider.
//
// Env vars are looked up with a computed key on purpose: a literal
// `process.env.X` in client-reachable code can be inlined at build time.

export type RuntimeConfig = {
  appName: string;
  appDomain: string;
  apiUrl: string;
  legalContactEmail: string;
  realtimeKey: string;
  realtimeHost: string;
  realtimePort: string;
  realtimeTls: boolean;
  realtimeCluster: string;
};

declare global {
  interface Window {
    __RUNTIME_CONFIG__?: RuntimeConfig;
  }
}

function env(name: string): string | undefined {
  return process.env[name] || undefined;
}

export function readRuntimeConfigFromEnv(): RuntimeConfig {
  return {
    appName: env('APP_NAME') || 'BetaPosition',
    // NEXT_PUBLIC_APP_DOMAIN is the old name, still honoured.
    appDomain: env('APP_DOMAIN') || env('NEXT_PUBLIC_APP_DOMAIN') || 'localhost:8003',
    apiUrl: env('API_URL') || '/api/v1',
    legalContactEmail: env('LEGAL_CONTACT_EMAIL') || '',
    // The key is the same one the server publishes with. HOST/PORT/TLS are
    // where *browsers* reach the realtime server, which differs from the
    // server-side REALTIME_HOST/PORT/TLS (e.g. an internal soketi:6001).
    realtimeKey: env('REALTIME_KEY') || '',
    realtimeHost: env('REALTIME_PUBLIC_HOST') || '',
    realtimePort: env('REALTIME_PUBLIC_PORT') || '',
    realtimeTls: env('REALTIME_PUBLIC_TLS') === 'true',
    realtimeCluster: env('REALTIME_CLUSTER') || 'mt1',
  };
}

export function getRuntimeConfig(): RuntimeConfig {
  if (typeof window !== 'undefined' && window.__RUNTIME_CONFIG__) return window.__RUNTIME_CONFIG__;
  return readRuntimeConfigFromEnv();
}
