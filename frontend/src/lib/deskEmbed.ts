/**
 * Who may frame the staff desk (/widget/desk). With Klargy Connect
 * (docs/connect/v1.md section 6) only the organisation's EMRs may: the
 * embedOrigins of its active integrations. An organisation with none keeps
 * the desk frameable anywhere, as the /embed/desk.js script has always
 * needed. Pure, so it's shared by the proxy and its tests.
 */

export const isDeskPath = (pathname: string) => pathname === '/widget/desk' || pathname.startsWith('/widget/desk/');

// embedOrigins are stored as URL origins already; this keeps anything else
// (spaces, quotes, semicolons) out of the header.
const ORIGIN_PATTERN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

/** The Content-Security-Policy value for the desk, or null for no header. */
export function deskFrameAncestors(origins: string[]): string | null {
  const allowed = [...new Set(origins.filter((o) => ORIGIN_PATTERN.test(o)))];
  if (allowed.length === 0) return null;
  return `frame-ancestors 'self' ${allowed.join(' ')}`;
}
