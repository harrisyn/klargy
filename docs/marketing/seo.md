# Marketing pages and search

The public pages that are meant to rank: `/`, `/use-cases`, `/use-cases/<slug>` and `/pricing`.
All of them except `/` render on the server, so the full text is in the first response.
Copy lives in `frontend/src/lib/marketing/useCases.ts`; pricing reads the active plans from the database.

## Keyword map

Each page targets one main phrase (in its title, H1 or first paragraph and description) and a few close variants.
These come from the terms competitors' industry pages and comparison articles use (Waitwhile, Qminder, Qwaiting,
TablesReady and others), not from a keyword volume tool. Check them in Google Search Console after launch and
adjust the titles of pages that get impressions without clicks.

| Page | Main phrase | Variants |
| --- | --- | --- |
| `/` | queue management system | virtual queue software, QR check-in |
| `/use-cases` | queue management system use cases | what is a queue management system, virtual queue, take-a-number |
| `/use-cases/clinics` | patient queue management system | clinic queue system, waiting room management, patient check-in |
| `/use-cases/hospitals` | hospital queue management system | outpatient flow, OPD queue, patient flow |
| `/use-cases/pharmacies` | pharmacy queue management | prescription line, prescription ready text |
| `/use-cases/restaurants` | restaurant waitlist app | virtual waitlist, table ready text, reservations |
| `/use-cases/salons-and-barbershops` | barbershop walk-in queue | salon waitlist, online check-in |
| `/use-cases/banks` | bank queue management system | branch queue, teller token system |
| `/use-cases/government-offices` | government office queue system | licensing office, permit office, DMV-style line |
| `/use-cases/retail-and-service-centres` | retail queue management | service centre queue, repair shop check-in |
| `/use-cases/schools-and-universities` | student services queue | registration queue, admissions appointments |
| `/use-cases/events-and-classes` | event check-in and seat booking | class booking, workshop seat booking |
| `/pricing` | queue management software pricing | queue management system cost |

## Rules for new pages

- Each use case page needs its own journey, example and questions. Near-identical pages per city or industry are
  treated by Google as doorway pages and can hurt the whole site.
- Examples are fictional and must stay labelled as such. Do not add made-up customer quotes, logos or statistics.
- Only describe what the product does today.

## After launch

1. Set `APP_URL` correctly (canonical links, sitemap and robots use it) and `SALES_CONTACT_EMAIL`.
2. Add the root domain to Google Search Console and Bing Webmaster Tools and submit `/sitemap.xml`.
3. Follow up with articles that answer longer questions and link to the use case pages (for example
   "how to reduce waiting time in a clinic", "how a restaurant waitlist works").
