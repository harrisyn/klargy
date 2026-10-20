import type { Metadata } from 'next';
import LegalPage, { LEGAL_CONTACT } from '@/components/LegalPage';
import { APP_NAME } from '@/lib/appConfig';

export const metadata: Metadata = { title: `Privacy Policy · ${APP_NAME}` };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="26 September 2026">
      <p>
        {APP_NAME} runs queues and appointments for the organizations that use it (clinics, restaurants, salons, offices and other service
        providers). This page explains what information is handled and why.
      </p>

      <h2>Who is responsible for your data</h2>
      <p>
        When you join a queue or book an appointment, the organization you are visiting decides what information to
        collect and is responsible for it. {APP_NAME} processes that information on their behalf. For questions about a
        specific visit, contact that organization directly.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Customers and visitors:</strong> the name, phone number, email and any identifiers (for example a member or record number) the organization asks for, plus your tickets, queue positions, and appointment times.</li>
        <li><strong>Staff accounts:</strong> name, work email, phone, role, and a securely hashed password.</li>
        <li><strong>Usage records:</strong> an audit log of queue actions (who called, served, transferred or cancelled a ticket, and when), and basic technical logs needed to run and secure the service.</li>
      </ul>

      <h2>How it is used</h2>
      <ul>
        <li>To place you in the right queue, show your position, and tell you when it is your turn (on screen, and by email or SMS if the organization turns that on).</li>
        <li>To let staff manage queues and appointments, and to produce wait-time and throughput reports for the organization.</li>
        <li>To send your visit details to the organization&apos;s own systems (such as their records system) where they have connected one.</li>
      </ul>
      <p>We do not sell personal information or use it for advertising.</p>

      <h2>AI features</h2>
      <p>
        If an organization turns on AI-assisted analytics, only aggregated queue statistics (counts, wait times, service
        times) are sent to the AI provider. Names, contact details and identifiers are not.
      </p>

      <h2>How long it is kept</h2>
      <p>
        Queue and appointment records are kept for as long as the organization&apos;s account is active, so they can
        report on past activity. Organizations can ask for records to be deleted.
      </p>

      <h2>Security</h2>
      <p>
        Data is encrypted in transit. Integration credentials and payment keys are encrypted at rest. Each
        organization&apos;s data is isolated from every other organization&apos;s.
      </p>

      <h2>Your choices</h2>
      <p>
        You can ask the organization you visited to see, correct or delete the information they hold about you.
        {LEGAL_CONTACT && <> You can also reach us at <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>.</>}
      </p>
    </LegalPage>
  );
}
