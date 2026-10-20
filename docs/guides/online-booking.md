# Online booking and industry templates

Klargy works for any business where people wait, or book a time and turn up for it: clinics, restaurants, salons, banks, offices, shops.

## Choose how customers get in (per service)

Services → add or edit a service → **How customers get in**:

| Setting | Public page offers |
|---|---|
| Walk-in only (default) | Join the line now |
| Appointments only | Book a time. Joining the line directly is refused; customers check in when they arrive |
| Both | "Join the line now" or "Book a time" |

A location whose services are all walk-in looks exactly as before. Kiosks (`?mode=kiosk`) only issue tickets.

## What a customer sees

1. The join page (QR code or link) asks **Join the line now** or **Book a time** when both are offered.
2. For a booking they pick a day and a time, then give a name and a phone number or email.
3. They get a private link, `https://<workspace>/booking/<token>`, on screen and by email. From it they can change the time, cancel, and **check in** on the day. Check-in puts them in the live queue, placed by their booked time when "booked arrivals" is on in Settings; they then follow the usual status page.
4. Staff see the booking on **Appointments** (marked "Booked online"). Reminders go out the day before like any appointment.

The slots come from each service's opening hours, active days, slot length and concurrency, so set those on the service. Bookings open up to 60 days ahead.

## Start from a template

Flow designer → **Use a template**. Pick your kind of business to preview the steps, who can book, and what waits for payment, then apply it to a location. Existing services with the same name are reused and nothing is removed. Templates exist for clinics, restaurants, salons, banks, government offices, shops and service centres, schools, and a single counter for anything else.

## Wording

Each organization's industry (or its own custom word) decides whether people are called patients, guests, clients, customers, visitors or students. Set it under Settings.

## Tables, seats and tickets

Edit a service → **Online booking and payment**.

- **What is booked:** "One booking per slot place" (default) or "People or seats". With seats, the customer says how many they are and the slot's capacity counts people, so a 40-cover dining room is one service with capacity 40. Set the smallest and largest party.
- **One-off sessions:** add a dated session with its own name, seats and price (a tasting night, a class, a screening). Tick "Only bookable at sessions I create" to stop the regular opening-hours slots altogether. A session can be on a day the service is normally closed. A session with bookings can't be deleted.
- Staff can book any party size on the Appointments page.

## Taking payment

On the same form, set a **price** (per booking or per person), and what customers pay when booking: nothing (pay at the venue), a **deposit** (a percentage) or the **full price**. Sessions can have their own price. Set the currency under **Payments**.

When a customer books a paid service, their place is held for 10 minutes while they pay on the card provider's page. If they close the payment page, "Continue to payment" on their booking page picks it up again while the place is held. If they don't pay, the place is released (the cleanup runs with the five-minute cron, so it can take up to about fifteen minutes). A payment that arrives after the hold lapsed still confirms the booking if the place is free, and is refunded automatically if it isn't.

Cancelling: the customer is refunded in full if they cancel at least the service's "refund cutoff" hours before the start (default 24), otherwise what they paid is kept. Staff cancelling a booking always refunds it in full.

### Who gets the money

Under **Payments** (organization admins):

1. **Your own account (paid plans, the "Own payment account for bookings" feature).** Connect Stripe or Paystack with your own keys. Money goes straight to you. Add the webhook URL shown on the page in your provider's dashboard (Stripe: `checkout.session.completed` and `checkout.session.expired`; Paystack: `charge.success`).
2. **Collected for you (every plan, when the platform has Stripe or Paystack switched on).** The platform's account takes the payment and credits your **payout wallet**. Each payment is held for the review period (7 days by default) and the platform's fee, if any, is deducted. Once the hold ends it becomes available; you add your payout details and **request a payout**, and the platform team reviews it, sends the money and marks it paid. You see what is held, available, in review and paid out.

If you have your own account connected, it is used; otherwise the platform's. If neither exists, services that ask for payment can't be booked online.

### Platform admins

- **Payouts** (superadmin sidebar): set the hold (days), the platform fee (%) and the smallest payout, and review payout requests. Mark a request **paid** only after sending the money (put the transfer reference in the note), or **reject** it to return the amount to the organization's available balance. Settings apply to new payments.
- Booking payments made through the platform's Stripe or Paystack arrive on the same webhook as plan billing (`/api/v1/webhooks/stripe`, `/paystack`). For Stripe, also send `checkout.session.expired` to that webhook.
- Turn on "Own payment account for bookings" in the plans that should include it (Superadmin → Plans).

## Currencies

Each organization has one currency. It is chosen when the organization signs up (the sign-up form preselects the likely one for the visitor's time zone) and again on the setup screen after first sign-in, and shown under **Payments**. Plan prices, the wallet, add-ons and booking payments are all in it. It can be changed by the organization until money has moved. After that a platform admin can change it from the organization's page, once the wallet and payout wallet are at zero, no payout request is open, no booking is waiting for payment and no card subscription is running. Organizations that existed before currencies were introduced start in their plan's currency.

Platform admins manage the list under **Currencies** (superadmin sidebar):

- Add a currency with its rate: "1 USD = 15.5 GHS". The base currency (USD) is always 1. **Refresh from market rates** pulls today's rates for the currencies in the list; it is a button, not a schedule, and you can still edit any rate by hand.
- A currency used by an organization or plan can't be removed. If one is in use without a rate, the page warns you; prices can't be converted until you add it.

**Subscriptions by currency.** On a plan (Superadmin → Plans) choose the plan's own currency, then under "Prices in other currencies" either leave a currency blank (the plan's price is converted at the current rate) or fill in monthly, quarterly and yearly prices to fix them by hand. Add-on prices are converted the same way. The dashboard's monthly revenue is converted back to the base currency. An organization sees plans, checkout and wallet charges in its own currency. Plans with no rate and no hand-set price for an organization's currency are shown in the plan's own currency.

## Connected systems

`PUT /appointments/{ref}` takes `partySize` and an optional `payment` (`total`, `paid`, `currency`); appointment responses and `appointment.*` events carry `partySize` and `payment`. A booking made on the public page is announced as `appointment.created` once confirmed: immediately for free bookings, when the payment arrives for paid ones. See docs/connect/v1.md.

## Rooms, tables and floor plans

Rooms group the things in a location and can have their own rules and rates. They are offered according to the organization's industry (Settings → kind of business):

| Industry | Rooms | Tables, seats and floor plans |
|---|---|---|
| Restaurant or café, salon, spa or studio, school, "something else" | Yes | Yes (called tables, chairs or seats) |
| Hospital or clinic, bank, government office, shop | Yes (for desks, rules and rates) | No: nothing about tables appears anywhere, and the API refuses it |

**Rooms** (sidebar → Rooms). A room has:

- **Rules:** bookable online or staff-only, smallest and largest party, the hours and days it takes bookings (overnight hours work), and whether a big party may be given several nearby tables.
- **Rates:** the service's price, the service's price plus a charge (per booking or per person), or a price of its own instead. A one-off session's own price still wins over a room's replacement price. A room can also set its own payment terms (nothing, deposit, full), deposit percentage, and refunds, either one notice period or steps such as "48 hours: 100%, 24 hours: 50%".
- **Desks:** put service point desks in the room (Desks button).
- A **service** can be delivered in a room (a treatment room, a private suite) from its edit form; that room's rules and rates then apply to its bookings.

**Floor plan** (Floor plan button, for industries with tables). A canvas where you add tables or chairs, drag them into place, set their name, seats, shape, size and rotation, and add a row of single seats for theatre-style rooms or a bar. Upload a photo or plan of the real room as the background and place everything on top of it. A table that still has upcoming bookings is switched off, not deleted, when you remove it.

**Booking.** On a service with "Give each booking a table", the booking page:

1. asks how many people, and (if the venue has more than one bookable room) where they would like to sit, showing what each area costs extra;
2. lists only times when a table is free for that party in that area, under that room's rules;
3. shows the price from the server, rate included;
4. offers **Choose my seat** (tap tables or seats on the floor plan; several can be chosen to reach the party size), or assigns the best free table automatically. A big party gets the nearest group of free tables in one room when no single one is big enough.

Two customers can never be given the same table: the choice and the booking are made together in one locked step. Staff can move a booking to other tables on the **Appointments** page ("Change table") and see who is where, at any time, from the room's **Tonight** view.

Tables are shared by every service at the location, so a "Dinner" and a "Lunch" service never double-book one.

### Arranging the floor plan

Drag tables to move them. Drag empty space (or Shift-click) to choose several, then move them together, set their seats, or line them up and space them evenly. Pull the squares on a chosen table to resize it and the circle above it to turn it (hold Alt for free turning). Arrow keys nudge, Delete removes, Ctrl+Z / Ctrl+Shift+Z undo and redo, and the zoom buttons help on big rooms.

### Moving a booking to another room

On Appointments, **Change table** moves a booking. If the new room has a different rate and the booking carries a price, you are shown the old and new price and must agree first. A dearer room leaves the difference to settle at the venue; a cheaper one refunds the difference to the customer. If that refund fails the booking is still moved and shows as overpaid; move it again to retry the refund.

### Templates

The restaurant, salon and "Class, workshop or event" templates also lay out rooms and tables (previewed before you apply). They are left out for kinds of business without tables, and applying a template twice changes nothing.
