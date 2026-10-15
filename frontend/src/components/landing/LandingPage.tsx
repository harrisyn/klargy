'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import LobbyScene from './LobbyScene';
import styles from './landing.module.css';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { APP_NAME } from '@/lib/appConfig';

const STEPS = [
  { title: 'Scan and join', text: 'A QR code at the entrance or a kiosk at reception issues a ticket in seconds. No app to install.' },
  { title: 'Wait anywhere', text: 'The ticket page shows their place in line and the estimated wait, updating live.' },
  { title: 'Get called', text: 'Their number goes up on the screen with the desk to go to, and they get a text or email.' },
  { title: 'Move on', text: 'Done with the doctor? Staff send them straight to the lab or pharmacy with a new ticket.' },
];

function Tick({ children }: { children: React.ReactNode }) {
  return (
    <li>
      <Check size={18} strokeWidth={2.4} aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className={styles.page}>
      <header className={`${styles.nav} ${scrolled ? styles.navScrolled : ''}`}>
        <Link href="/" className={styles.brand} aria-label={`${APP_NAME} home`}>
          <BrandLogo height={36} compactBelow={480} />
        </Link>
        <nav className={styles.navLinks} aria-label="Site">
          <a href="#how-it-works" className={`${styles.navLink} ${styles.navHideSm}`}>How it works</a>
          <a href="#screens" className={`${styles.navLink} ${styles.navHideSm}`}>Screens</a>
          <Link href="/login" className={styles.navLink}>Sign in</Link>
          <Link href="/register" className={`${styles.btnPrimary} ${styles.btnSmall}`}>Start free</Link>
        </nav>
      </header>

      <main>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroText}>
            <h1 id="hero-title" className={styles.headline}>Run a calmer waiting room.</h1>
            <p className={styles.lede}>
              People scan a QR code, get a ticket on their phone, and are called to the right desk when it&apos;s
              their turn. Clinics, banks, offices, service centres: anywhere people wait for a desk, room or counter.
            </p>
            <div className={styles.ctaRow}>
              <Link href="/register" className={styles.btnPrimary}>Start free</Link>
              <a href="#how-it-works" className={styles.btnSecondary}>See how a visit works</a>
            </div>
            <p className={styles.ctaNote}>Free plan for one location. Set up in an afternoon.</p>
          </div>
          <div className={styles.sceneWrap}>
            <LobbyScene />
          </div>
        </section>

        <section id="how-it-works" className={styles.section} aria-labelledby="journey-title">
          <h2 id="journey-title" className={styles.sectionTitle}>One ticket follows the whole visit.</h2>
          <p className={styles.sectionLede}>
            Most visits aren&apos;t one queue. {APP_NAME} carries each person from step to step, so nobody has to
            line up again or explain where they&apos;ve been.
          </p>
          <ol className={styles.journey}>
            {STEPS.map((step, i) => (
              <li key={step.title} className={styles.step}>
                <span className={styles.stepNumber}>{i + 1}</span>
                <h3 className={styles.stepTitle}>{step.title}</h3>
                <p className={styles.stepText}>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.section} aria-label="Who it's for">
          <div className={styles.rows}>
            <div className={styles.row}>
              <div className={styles.rowText}>
                <p className={styles.rowFor}>For the people you serve</p>
                <h3 className={styles.rowTitle}>Sit down, grab a coffee, keep your place.</h3>
                <ul className={styles.rowList}>
                  <Tick>Live position and wait time on their own phone</Tick>
                  <Tick>A text or email when they&apos;re nearly up, and when it&apos;s their turn</Tick>
                  <Tick>Family tickets from one phone, or a kiosk for walk-ins without one</Tick>
                </ul>
              </div>
              <div className={styles.phone} aria-hidden="true">
                <div className={styles.phoneScreen}>
                  <p className={styles.phoneLabel}>Your ticket for Consultation</p>
                  <p className={styles.phoneTicket}>C017</p>
                  <div className={styles.phonePos}>
                    <div><strong>3rd</strong><span>in line</span></div>
                    <div><strong>~12 min</strong><span>wait</span></div>
                  </div>
                  <p className={styles.phoneNote}>We&apos;ll text you when you&apos;re next.</p>
                </div>
              </div>
            </div>

            <div className={`${styles.row} ${styles.rowFlip}`}>
              <div className={styles.rowText}>
                <p className={styles.rowFor}>For the front desk</p>
                <h3 className={styles.rowTitle}>Call the next person with one tap.</h3>
                <ul className={styles.rowList}>
                  <Tick>Each desk or room calls from its own list, with priority for booked appointments</Tick>
                  <Tick>Book, reschedule and check in appointments in the same place</Tick>
                  <Tick>Send someone on to the next service without re-registering them</Tick>
                </ul>
              </div>
              <div className={styles.fragment} aria-hidden="true">
                <div className={styles.deskHead}><strong>Consulting room 2</strong><span>6 waiting</span></div>
                <ul className={styles.deskList}>
                  <li className={styles.deskServing}><span className={styles.deskTicket}>C014</span>Ama Owusu<span className={styles.deskMeta}>With you for 4 min</span></li>
                  <li><span className={styles.deskTicket}>C015</span>Kwame Mensah<span className={styles.deskMeta}>Booked 10:30</span></li>
                  <li><span className={styles.deskTicket}>C016</span>Grace Addo<span className={styles.deskMeta}>Waiting 9 min</span></li>
                  <li><span className={styles.deskTicket}>C017</span>Yaw Boateng<span className={styles.deskMeta}>Waiting 6 min</span></li>
                </ul>
                <div className={styles.deskActions}>
                  <span className={styles.deskBtn}>Send to lab</span>
                  <span className={`${styles.deskBtn} ${styles.deskBtnMain}`}>Call next</span>
                </div>
              </div>
            </div>

            <div className={styles.row}>
              <div className={styles.rowText}>
                <p className={styles.rowFor}>For managers</p>
                <h3 className={styles.rowTitle}>See where the day slows down, and why.</h3>
                <ul className={styles.rowList}>
                  <Tick>Waits, service times and no-shows by service, hour and weekday</Tick>
                  <Tick>Ask questions in plain language and get answers backed by your numbers</Tick>
                  <Tick>Every call, transfer and cancellation in an audit log; send events to your records system</Tick>
                </ul>
              </div>
              <div className={styles.fragment} aria-hidden="true">
                <p className={styles.askQ}>When should we add a second pharmacist?</p>
                <p className={styles.askA}>
                  Tuesday and Thursday, 10:00 to 12:00. Pharmacy waits average 31 minutes then, against 9 minutes the
                  rest of the week, and arrivals roughly double.
                </p>
                <div className={styles.bars}>
                  {[22, 30, 64, 88, 70, 38, 28, 24, 30, 20].map((h, i) => (
                    <span key={i} className={`${styles.bar} ${i === 3 || i === 4 ? styles.barHot : ''}`} style={{ height: `${h}%` }} />
                  ))}
                </div>
                <div className={styles.barsLegend}><span>08:00</span><span>13:00</span><span>17:00</span></div>
              </div>
            </div>
          </div>
        </section>

        <section id="screens" className={styles.tvSection} aria-labelledby="tv-title">
          <div className={styles.section}>
            <h2 id="tv-title" className={styles.sectionTitle}>A lobby screen that earns its wall space.</h2>
            <p className={styles.sectionLede}>
              Put the queue on any TV with a browser. Between calls, play your own announcements, health messages or
              adverts, with a news-style ticker along the bottom. When a number is called, the queue takes over the
              screen straight away.
            </p>
            <div className={styles.tv} aria-hidden="true">
              <div className={styles.tvQueue}>
                <div className={styles.tvNow}><b>C014</b><span>Consulting room 2</span></div>
                <div className={styles.tvNow} style={{ background: 'rgba(255,255,255,0.05)' }}>
                  <b style={{ color: '#dfe6ea', fontSize: 'clamp(1.5rem,3.5vw,2.5rem)' }}>P006</b>
                  <span>Pharmacy</span>
                </div>
                <div className={styles.tvNext}><span>C015</span><span>C016</span><span>L003</span><span>P007</span></div>
              </div>
              <div className={styles.tvAd}>
                <span className={styles.tvAdTag}>Your content</span>
                <p>Flu vaccines now available at the pharmacy</p>
                <small>Ask at the desk, no appointment needed</small>
              </div>
              <div className={styles.tvTicker}>
                <span className={styles.tvTickerTrack}>
                  Clinic hours today 08:00 to 18:00 &nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp; Please keep your phone on to hear when you&apos;re called &nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp; Free Wi-Fi: Guest
                </span>
              </div>
            </div>
            <ul className={styles.tvPoints}>
              <li><strong>Your media, your schedule</strong>Upload images and videos, set how long each plays and when a campaign starts and ends.</li>
              <li><strong>Calls always come first</strong>A new call interrupts whatever is playing, with a chime and the number in large type.</li>
              <li><strong>Your brand on screen</strong>Your logo and colours on the board, the ticket pages and your own web address.</li>
            </ul>
          </div>
        </section>

        <section className={`${styles.section} ${styles.closing}`}>
          <div className={styles.closingInner}>
            <div>
              <h2>Set up your first queue this afternoon.</h2>
              <p>Create your organization, add a location and a service, and print the QR code. The first people can join before the end of the day.</p>
            </div>
            <Link href="/register" className={styles.btnInverse}>Start free</Link>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span>© {new Date().getFullYear()} {APP_NAME}</span>
        <div className={styles.footerLinks}>
          <Link href="/locations">Find a location</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/login">Sign in</Link>
        </div>
      </footer>
    </div>
  );
}
