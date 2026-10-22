import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import MarketingShell, { Breadcrumbs, ClosingCta, Faqs } from '@/components/marketing/MarketingShell';
import styles from '@/components/marketing/marketing.module.css';
import { GENERAL_FAQS, USE_CASES } from '@/lib/marketing/useCases';
import { jsonLd, siteUrl } from '@/lib/marketing/site';
import { APP_NAME } from '@/lib/appConfig';

const DESCRIPTION =
  'Queue management software for clinics, hospitals, restaurants, salons, banks, government offices, retail and universities. Virtual queues, QR check-in and live screens.';

export function generateMetadata(): Metadata {
  const title = `Queue Management System Use Cases by Industry | ${APP_NAME}`;
  const url = siteUrl('/use-cases');
  return {
    title,
    description: DESCRIPTION,
    alternates: { canonical: url },
    openGraph: { title, description: DESCRIPTION, url, siteName: APP_NAME, type: 'website' },
    twitter: { card: 'summary', title, description: DESCRIPTION },
  };
}

export default function UseCasesPage() {
  const structured = [
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: APP_NAME, item: siteUrl('/') },
        { '@type': 'ListItem', position: 2, name: 'Use cases', item: siteUrl('/use-cases') },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: USE_CASES.map((u, i) => ({ '@type': 'ListItem', position: i + 1, name: u.name, url: siteUrl(`/use-cases/${u.slug}`) })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: GENERAL_FAQS.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    },
  ];

  return (
    <MarketingShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(structured)} />
      <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Use cases', href: '/use-cases' }]} />

      <section className={`${styles.hero} ${styles.heroSolo}`} aria-labelledby="hero-title">
        <div>
          <p className={styles.eyebrow}>Queue management system for every industry</p>
          <h1 id="hero-title" className={styles.headline}>Wherever people wait, one calmer queue.</h1>
          <p className={styles.lede}>
            {APP_NAME} is queue management software for clinics, hospitals, restaurants, salons, banks, government
            offices, shops and universities. People join a virtual queue with a QR code, wait wherever they like, and
            are called to the right desk, room or table when it is their turn.
          </p>
          <div className={styles.ctaRow}>
            <Link href="/register" className={styles.btnPrimary}>Start free</Link>
            <Link href="/pricing" className={styles.btnSecondary}>See pricing</Link>
          </div>
        </div>
      </section>

      <section className={`${styles.section} ${styles.sectionTight}`} aria-labelledby="cases-title">
        <h2 id="cases-title" className={styles.sectionTitle}>Find your kind of place</h2>
        <p className={styles.sectionLede}>
          Each comes with a ready-made setup: the steps of a typical visit, the desks or rooms, and the right word for
          the people you serve, whether patients, guests, clients or customers.
        </p>
        <ul className={styles.caseGrid}>
          {USE_CASES.map((u) => (
            <li key={u.slug}>
              <Link href={`/use-cases/${u.slug}`} className={styles.caseCard}>
                <h3>{u.name}</h3>
                <p>{u.summary}</p>
                <span className={styles.caseMore}>See how it works <ArrowRight size={16} aria-hidden="true" /></span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section} aria-labelledby="what-title">
        <div className={styles.prose}>
          <h2 id="what-title" className={styles.sectionTitle}>What is a queue management system?</h2>
          <p>
            A queue management system decides who is next and tells them. Instead of a line at the counter or a paper
            list at reception, each person gets a ticket, by scanning a QR code, at a self-service kiosk, or from a
            member of staff. The ticket shows their place in line and an estimated wait, and updates live.
          </p>
          <p>
            Staff call the next person from their own desk, room or counter with one tap. The number goes up on a
            lobby screen, and the person gets a text, email or WhatsApp message. When one step is done, staff send
            them straight to the next, like the cashier, the lab or the stylist, without making them line up again.
          </p>
          <p>
            Because every ticket is timed, managers see waiting and service times by service, hour and weekday, and can
            staff for the busy hours instead of guessing. That is the difference between a take-a-number machine and
            a virtual queue: the line becomes something you can measure and improve.
          </p>
        </div>
      </section>

      <Faqs faqs={GENERAL_FAQS} title="Queue management questions" />

      <ClosingCta
        title="Set up your first queue this afternoon."
        text="Create your organization, pick the setup for your kind of place, and print the QR code."
      />
    </MarketingShell>
  );
}
