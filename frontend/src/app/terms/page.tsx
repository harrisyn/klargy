import type { Metadata } from 'next';
import LegalPage, { LEGAL_CONTACT } from '@/components/LegalPage';
import { APP_NAME } from '@/lib/appConfig';

export const metadata: Metadata = { title: `Terms of Service · ${APP_NAME}` };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="26 September 2026">
      <p>
        These terms cover use of {APP_NAME} by organizations that run queues and appointments on it, their staff, and
        the people who join those queues.
      </p>

      <h2>Using the service</h2>
      <ul>
        <li>Organizations are responsible for the accounts they create, for the information they ask their customers to provide, and for having a lawful basis to collect it.</li>
        <li>Staff must keep their sign-in details private and only access their own organization&apos;s data.</li>
        <li>Don&apos;t misuse the service: no attempts to access other organizations&apos; data, overload the system, or use it to send unsolicited messages.</li>
      </ul>

      <h2>Queue times are estimates</h2>
      <p>
        Positions and wait times shown to customers are estimates based on current activity. The organization you are
        visiting decides the actual order in which people are seen, including emergencies and priority cases.
      </p>

      <h2>Plans and billing</h2>
      <p>
        Paid plans, add-ons and message credits are billed in advance through the payment provider shown at checkout.
        Plan limits (locations, users, monthly queue entries, message credits) apply as described on the billing page.
      </p>

      <h2>Integrations and AI</h2>
      <p>
        Organizations that connect outside systems (such as a records system) or turn on AI-assisted analytics
        are responsible for their configuration and for how they use the results. AI output is guidance and should be
        checked before acting on it.
      </p>

      <h2>Availability</h2>
      <p>
        We work to keep the service running and to fix problems quickly, but it is provided without a guarantee of
        uninterrupted availability. Organizations should keep a fallback for serving people during an outage.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. Material changes will be announced to organization admins before they take effect.
        {LEGAL_CONTACT && <> Questions: <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>.</>}
      </p>
    </LegalPage>
  );
}
