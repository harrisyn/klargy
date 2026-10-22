import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { Check } from 'lucide-react';
import MarketingShell, { Breadcrumbs, ClosingCta, Faqs } from '@/components/marketing/MarketingShell';
import styles from '@/components/marketing/marketing.module.css';
import prisma from '@/server/lib/prisma';
import { FEATURE_LABELS } from '@/lib/planFeatures';
import { jsonLd, salesContactHref, siteUrl } from '@/lib/marketing/site';
import { APP_NAME } from '@/lib/appConfig';

const DESCRIPTION =
  'Queue management pricing: a free plan for one location, paid plans for growing and multi-location teams, and a custom fee we agree with you when a plan does not fit.';

export function generateMetadata(): Metadata {
  const title = `Pricing: Queue Management Software Plans | ${APP_NAME}`;
  const url = siteUrl('/pricing');
  return {
    title,
    description: DESCRIPTION,
    alternates: { canonical: url },
    openGraph: { title, description: DESCRIPTION, url, siteName: APP_NAME, type: 'website' },
    twitter: { card: 'summary', title, description: DESCRIPTION },
  };
}

interface PublicPlan {
  name: string;
  code: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number;
  currency: string;
  maxLocations: number | null;
  maxServicesPerLoc: number | null;
  maxUsersPerOrg: number | null;
  maxQueueEntriesPerDay: number | null;
  maxQueueEntriesPerPeriod: number | null;
  features: Record<string, unknown>;
  trialDurationDays: number | null;
  isRecommended: boolean;
}

// Shown when the database can't be read (e.g. a build without one). Mirrors
// the base plans seeded by prisma/migrations/20261019000000_seed_base_plans.
const DEFAULT_PLANS: PublicPlan[] = [
  {
    name: 'Free', code: 'free', description: 'Get started at no cost', priceMonthly: 0, priceYearly: 0, currency: 'USD',
    maxLocations: 1, maxServicesPerLoc: 1, maxUsersPerOrg: 1, maxQueueEntriesPerDay: 100, maxQueueEntriesPerPeriod: null,
    features: { servicePoints: true }, trialDurationDays: null, isRecommended: false,
  },
  {
    name: 'Starter', code: 'starter', description: null, priceMonthly: 100, priceYearly: 1000, currency: 'USD',
    maxLocations: 2, maxServicesPerLoc: 3, maxUsersPerOrg: 5, maxQueueEntriesPerDay: 500, maxQueueEntriesPerPeriod: null,
    features: { analytics: true, displayMedia: true, multiLocation: true, servicePoints: true, smsNotifications: true },
    trialDurationDays: 14, isRecommended: true,
  },
  {
    name: 'Pro', code: 'pro', description: 'For growing multi-location organizations', priceMonthly: 300, priceYearly: 3000, currency: 'USD',
    maxLocations: 5, maxServicesPerLoc: 10, maxUsersPerOrg: 10, maxQueueEntriesPerDay: null, maxQueueEntriesPerPeriod: null,
    features: { analytics: true, apiAccess: true, customDomain: true, displayMedia: true, serviceFlows: true, multiLocation: true, servicePoints: true, customBranding: true, smsNotifications: true },
    trialDurationDays: 7, isRecommended: false,
  },
];

const PLAN_BLURBS: Record<string, string> = {
  free: 'One location, one service. Try it with real people.',
  starter: 'For a busy single site or two branches.',
};

async function loadPlans(): Promise<PublicPlan[]> {
  try {
    const rows = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: [{ tierRank: 'asc' }, { displayOrder: 'asc' }],
    });
    if (rows.length === 0) return DEFAULT_PLANS;
    return rows.map((p) => ({
      name: p.name,
      code: p.code,
      description: p.description,
      priceMonthly: Number(p.priceMonthly),
      priceYearly: Number(p.priceYearly),
      currency: p.currency,
      maxLocations: p.maxLocations,
      maxServicesPerLoc: p.maxServicesPerLoc,
      maxUsersPerOrg: p.maxUsersPerOrg,
      maxQueueEntriesPerDay: p.maxQueueEntriesPerDay,
      maxQueueEntriesPerPeriod: p.maxQueueEntriesPerPeriod,
      features: (p.features && typeof p.features === 'object' ? p.features : {}) as Record<string, unknown>,
      trialDurationDays: p.trialDurationDays,
      isRecommended: p.isRecommended,
    }));
  } catch {
    return DEFAULT_PLANS;
  }
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

const count = (n: number) => n.toLocaleString('en');

function limits(plan: PublicPlan): string[] {
  const out: string[] = [];
  out.push(plan.maxLocations === null ? 'Unlimited locations' : plan.maxLocations === 1 ? '1 location' : `Up to ${plan.maxLocations} locations`);
  out.push(plan.maxServicesPerLoc === null ? 'Unlimited services' : plan.maxServicesPerLoc === 1 ? '1 service per location' : `Up to ${plan.maxServicesPerLoc} services per location`);
  out.push(plan.maxUsersPerOrg === null ? 'Unlimited staff accounts' : plan.maxUsersPerOrg === 1 ? '1 staff account' : `${plan.maxUsersPerOrg} staff accounts`);
  if (plan.maxQueueEntriesPerDay !== null) out.push(`Up to ${count(plan.maxQueueEntriesPerDay)} people a day`);
  if (plan.maxQueueEntriesPerPeriod !== null) out.push(`Up to ${count(plan.maxQueueEntriesPerPeriod)} people a billing period`);
  if (plan.maxQueueEntriesPerDay === null && plan.maxQueueEntriesPerPeriod === null) out.push('No cap on people served');
  return out;
}

function featureLabels(plan: PublicPlan): string[] {
  const labels = Object.entries(plan.features)
    .filter(([key, on]) => on === true && FEATURE_LABELS[key])
    .map(([key]) => FEATURE_LABELS[key]);
  return [...new Set(labels)];
}

const INCLUDED = [
  'QR code check-in, with no app to install',
  'Kiosk mode for a tablet at the door',
  'Live place in line and wait time on the phone',
  'Email alerts when people are nearly up',
  'Lobby TV display with called numbers',
  'Walk-ins and appointments in one list',
  'Family tickets from one phone',
  'Ready-made setups for your kind of place',
  'Words that fit you: patients, guests, clients',
];

const CUSTOM_POINTS = [
  'A fee we agree together, monthly or yearly',
  'More locations, staff and visitors than the plans',
  'Message volumes priced for your size',
  'Help connecting your records, CRM or POS system',
  'Help setting up screens, kiosks and journeys',
];

const PRICING_FAQS = [
  { q: 'Can we agree a different price?', a: 'Yes. The prices here are our standard plans, not the only option. If your size, budget or setup does not fit a plan, for example a chain of branches, a public service or a non-profit, talk to us and we will set a fee with you.' },
  { q: 'Is there really a free plan?', a: `Yes. The free plan runs one location with one service and one staff account, with no time limit. It is enough to try ${APP_NAME} with real people before you pay anything.` },
  { q: 'Do paid plans have a free trial?', a: 'Paid plans start with a free trial. If you do not continue, your organization moves to a lower plan and keeps its setup.' },
  { q: 'Can I add more locations or staff without changing plan?', a: 'Yes. Extra locations, extra staff and a lobby media pack can be added to a plan from the billing page.' },
  { q: 'Do I need to buy hardware?', a: 'No. Any TV with a browser can be the lobby screen, any tablet can be the kiosk, and staff use the computers and phones they already have.' },
  { q: 'Can I pay yearly?', a: 'Yes. Plans can be paid monthly, quarterly or yearly, and longer periods cost less per month.' },
];

export default async function PricingPage() {
  await connection();
  const plans = await loadPlans();
  const top = plans[plans.length - 1];
  const talkHref = salesContactHref(`${APP_NAME} pricing`);

  const structured = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: APP_NAME,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      description: 'Queue management system with virtual queues, QR check-in, appointments and lobby displays.',
      url: siteUrl('/'),
      offers: plans.map((p) => ({ '@type': 'Offer', name: p.name, price: p.priceMonthly.toFixed(2), priceCurrency: p.currency, url: siteUrl('/pricing') })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: PRICING_FAQS.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    },
  ];

  return (
    <MarketingShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(structured)} />
      <Breadcrumbs items={[{ name: 'Home', href: '/' }, { name: 'Pricing', href: '/pricing' }]} />

      <section className={`${styles.hero} ${styles.heroSolo}`} aria-labelledby="hero-title">
        <div>
          <p className={styles.eyebrow}>Queue management pricing</p>
          <h1 id="hero-title" className={styles.headline}>Start free. Grow when the line does.</h1>
          <p className={styles.lede}>
            A free plan for one location, paid plans for busy sites and growing teams, and a fee we agree with you
            when none of them fit. Every price here is a starting point for a conversation.
          </p>
        </div>
      </section>

      <section className={`${styles.section} ${styles.sectionTight}`} aria-label="Plans">
        <div className={styles.plans}>
          {plans.map((plan) => {
            const free = plan.priceMonthly === 0;
            const yearlySaving = plan.priceMonthly > 0 && plan.priceYearly > 0
              ? Math.round((1 - plan.priceYearly / (plan.priceMonthly * 12)) * 100)
              : 0;
            return (
              <article key={plan.code} className={`${styles.plan} ${plan.isRecommended ? styles.planRecommended : ''}`}>
                {plan.isRecommended && <span className={styles.planBadge}>Most popular</span>}
                <h2 className={styles.planName}>{plan.name}</h2>
                <p className={styles.planDesc}>{plan.description || PLAN_BLURBS[plan.code] || ''}</p>
                <p className={styles.planPrice}>
                  <strong>{free ? 'Free' : money(plan.priceMonthly, plan.currency)}</strong>
                  <span>{free ? 'forever' : 'a month'}</span>
                </p>
                <p className={styles.planYearly}>
                  {!free && plan.priceYearly > 0 && (
                    <>or {money(plan.priceYearly, plan.currency)} a year{yearlySaving > 0 ? ` (save ${yearlySaving}%)` : ''}</>
                  )}
                </p>
                <Link
                  href="/register"
                  className={`${plan.isRecommended ? styles.btnPrimary : styles.btnSecondary} ${styles.btnBlock} ${styles.planCta}`}
                >
                  {free ? 'Start free' : plan.trialDurationDays ? `Start ${plan.trialDurationDays}-day trial` : `Choose ${plan.name}`}
                </Link>
                <ul className={styles.planList}>
                  {[...limits(plan), ...featureLabels(plan)].map((line) => (
                    <li key={line}><Check size={16} strokeWidth={2.4} aria-hidden="true" />{line}</li>
                  ))}
                </ul>
              </article>
            );
          })}

          <article className={`${styles.plan} ${styles.planCustom}`}>
            <h2 className={styles.planName}>Custom</h2>
            <p className={styles.planDesc}>For chains, hospitals, public services and anyone who needs a different deal.</p>
            <p className={styles.planPrice}>
              <strong>Let&apos;s talk</strong>
            </p>
            <p className={styles.planYearly}>A fee set with you</p>
            <a href={talkHref} className={`${styles.btnInverse} ${styles.btnBlock} ${styles.planCta}`}>Talk to us</a>
            <ul className={styles.planList}>
              {top && <li><Check size={16} strokeWidth={2.4} aria-hidden="true" />Everything in {top.name}</li>}
              {CUSTOM_POINTS.map((line) => (
                <li key={line}><Check size={16} strokeWidth={2.4} aria-hidden="true" />{line}</li>
              ))}
            </ul>
          </article>
        </div>

        <div className={styles.negotiate}>
          <div>
            <h2>Not sure a plan fits? We can always agree a fee.</h2>
            <p>
              Tell us how many locations you run, how many people you serve and what you can spend. We will suggest a
              plan or set a price that works for you, whether you are one clinic or a national network.
            </p>
          </div>
          <a href={talkHref} className={styles.btnPrimary}>Talk to us about pricing</a>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="included-title">
        <h2 id="included-title" className={styles.sectionTitle}>Included on every plan</h2>
        <ul className={styles.included}>
          {INCLUDED.map((line) => (
            <li key={line}><Check size={18} strokeWidth={2.4} aria-hidden="true" />{line}</li>
          ))}
        </ul>
        <p className={styles.sectionLede}>
          See how it fits your kind of place in <Link href="/use-cases" style={{ color: 'var(--primary-700)', textDecoration: 'underline' }}>our use cases</Link>.
        </p>
      </section>

      <Faqs faqs={PRICING_FAQS} title="Pricing questions" />

      <ClosingCta
        title="Try it free, then decide."
        text="The free plan has no time limit. Upgrade when you need more locations, staff or features, or talk to us about a fee."
        secondary={{ name: 'See use cases', href: '/use-cases' }}
      />
    </MarketingShell>
  );
}
