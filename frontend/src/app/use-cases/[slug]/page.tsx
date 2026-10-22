import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Check, CircleCheck } from 'lucide-react';
import MarketingShell, { Breadcrumbs, ClosingCta, Faqs } from '@/components/marketing/MarketingShell';
import styles from '@/components/marketing/marketing.module.css';
import { USE_CASES, findUseCase } from '@/lib/marketing/useCases';
import { jsonLd, siteUrl } from '@/lib/marketing/site';
import { APP_NAME } from '@/lib/appConfig';

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return USE_CASES.map((u) => ({ slug: u.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const useCase = findUseCase((await params).slug);
  if (!useCase) return {};
  const url = siteUrl(`/use-cases/${useCase.slug}`);
  const title = `${useCase.metaTitle} | ${APP_NAME}`;
  return {
    title,
    description: useCase.metaDescription,
    alternates: { canonical: url },
    openGraph: { title, description: useCase.metaDescription, url, siteName: APP_NAME, type: 'website' },
    twitter: { card: 'summary', title, description: useCase.metaDescription },
  };
}

export default async function UseCasePage({ params }: Props) {
  const useCase = findUseCase((await params).slug);
  if (!useCase) notFound();
  const related = useCase.related.map(findUseCase).filter((u) => u !== undefined);
  const url = siteUrl(`/use-cases/${useCase.slug}`);

  const structured = [
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: APP_NAME, item: siteUrl('/') },
        { '@type': 'ListItem', position: 2, name: 'Use cases', item: siteUrl('/use-cases') },
        { '@type': 'ListItem', position: 3, name: useCase.name, item: url },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: useCase.faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    },
  ];

  return (
    <MarketingShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(structured)} />
      <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Use cases', href: '/use-cases' }, { name: useCase.name, href: `/use-cases/${useCase.slug}` }]} />

      <section className={styles.hero} aria-labelledby="hero-title">
        <div>
          <p className={styles.eyebrow}>{useCase.eyebrow}</p>
          <h1 id="hero-title" className={styles.headline}>{useCase.title}</h1>
          <p className={styles.lede}>{useCase.lede}</p>
          <div className={styles.ctaRow}>
            <Link href="/register" className={styles.btnPrimary}>Start free</Link>
            <Link href="/pricing" className={styles.btnSecondary}>See pricing</Link>
          </div>
          <p className={styles.ctaNote}>Free plan for one location. Nothing for anyone to install.</p>
        </div>
        <div className={styles.fragment} aria-hidden="true">
          <div className={styles.deskHead}><strong>{useCase.desk.title}</strong><span>{useCase.desk.waiting}</span></div>
          <ul className={styles.deskList}>
            {useCase.desk.rows.map((row) => (
              <li key={row.ticket}>
                <span className={styles.deskTicket}>{row.ticket}</span>
                <span className={styles.deskName}>{row.name}</span>
                <span className={styles.deskMeta}>{row.meta}</span>
              </li>
            ))}
          </ul>
          <div className={styles.deskActions}>
            <span className={styles.deskBtn}>{useCase.desk.secondary}</span>
            <span className={`${styles.deskBtn} ${styles.deskBtnMain}`}>{useCase.desk.primary}</span>
          </div>
        </div>
      </section>

      <section className={`${styles.section} ${styles.sectionTight}`} aria-labelledby="pains-title">
        <h2 id="pains-title" className={styles.sectionTitle}>What makes the wait worse</h2>
        <div className={styles.cards3}>
          {useCase.pains.map((p) => (
            <div key={p.title} className={styles.card}>
              <h3>{p.title}</h3>
              <p>{p.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="journey-title">
        <h2 id="journey-title" className={styles.sectionTitle}>{useCase.journeyTitle}</h2>
        <p className={styles.sectionLede}>
          {APP_NAME} comes with a ready-made setup for {useCase.name.toLowerCase()}. Rename the steps, add or remove
          them, and you are ready to go.
        </p>
        <ol className={styles.journey}>
          {useCase.journey.map((step, i) => (
            <li key={step.name} className={styles.journeyStep}>
              <span className={styles.stepNumber}>{i + 1}</span>
              <div>
                <h3>{step.name}</h3>
                <p>{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.section} aria-labelledby="story-title">
        <div className={styles.story}>
          <span className={styles.storyTag}>Illustrative example · fictional business</span>
          <h2 id="story-title">{useCase.example.name}</h2>
          <p className={styles.storyKind}>A made-up {useCase.example.kind}, to show how a day changes.</p>
          <p style={{ margin: '1.25rem 0 0', lineHeight: 1.65, maxWidth: '70ch' }}>{useCase.example.setting}</p>
          <div className={styles.storyGrid}>
            <div>
              <h3>Before</h3>
              <p>{useCase.example.before}</p>
            </div>
            <div>
              <h3>With {APP_NAME}</h3>
              <p>{useCase.example.after}</p>
            </div>
          </div>
          <ul className={styles.storyChanges}>
            {useCase.example.changes.map((c) => (
              <li key={c}><CircleCheck size={18} aria-hidden="true" /><span>{c}</span></li>
            ))}
          </ul>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="features-title">
        <h2 id="features-title" className={styles.sectionTitle}>Built for {useCase.name.toLowerCase()}</h2>
        <div className={styles.features}>
          {useCase.features.map((f) => (
            <div key={f.title} className={styles.feature}>
              <h3><Check size={18} strokeWidth={2.4} aria-hidden="true" />{f.title}</h3>
              <p>{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      <Faqs faqs={useCase.faqs} />

      <section className={`${styles.section} ${styles.sectionTight}`} aria-labelledby="related-title">
        <h2 id="related-title" className={styles.sectionTitle} style={{ fontSize: '1.5rem' }}>Also used by</h2>
        <div className={styles.related}>
          {related.map((u) => (
            <Link key={u.slug} href={`/use-cases/${u.slug}`}>{u.name}</Link>
          ))}
          <Link href="/use-cases">All use cases</Link>
        </div>
      </section>

      <ClosingCta
        title="Set up your first queue this afternoon."
        text="Create your organization, pick the ready-made setup, and print the QR code. The first people can join before the end of the day."
      />
    </MarketingShell>
  );
}
