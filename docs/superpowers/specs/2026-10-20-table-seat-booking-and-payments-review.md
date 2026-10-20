# Review: booking tables and seats, and taking payment for bookings

Date: 2026-10-20. Status: review and proposal, nothing built yet. Context: online booking shipped on 2026-10-20 (see `docs/guides/online-booking.md`).

## Verdict

| Need | Possible today? | Why |
|---|---|---|
| Book a time for a service (salon, bank, office) | Yes | Shipped |
| Book a table for N people | **Partly** | A slot holds a count of *bookings*, not people. A "Table for 4" service with `concurrentLimit` = number of such tables works, but the customer can't say how many they are and one booking always uses one place |
| Reserve seats or tickets (event, cinema, class) | **No** | No quantity on a booking, and slots only come from weekly opening hours, so a one-off "Friday 19:00, 80 seats" session can't be created |
| Customer pays when booking (deposit, full price, ticket) | **No** | Payment providers (Stripe, Paystack) are the *platform's* accounts and only bill organizations for plans and add-ons. Nothing takes money from an organization's own customers, and services, slots and appointments have no price or currency |
| "Paid" gating a service | Partly | `requiresClearance` holds a ticket in "awaiting payment" until staff or a connected system clears it. It records that payment happened elsewhere; it doesn't collect money |

So tables are close, seats and tickets need a small data change, and payment is a new capability (the largest piece).

## Gaps, concretely

1. `Appointment` has no `partySize`/`quantity`; `claimSlot` adds exactly 1 to `Slot.bookedCount`.
2. `Slot.capacity` comes from `Service.concurrentLimit`; slots are generated only from `startTime/endTime/slotDuration/activeDays`. No admin-defined sessions, no per-session capacity or price.
3. No `price`, `currency` or payment fields on `Service`, `Slot` or `Appointment`; no currency on `Organization` (plans carry one).
4. `PaymentProvider` (`services/payments/types.ts`) only has `createCheckoutSession` for plans and `createAddOnCheckoutSession`; the webhook event type is plan/add-on shaped.
5. A booking is created confirmed. There is no "pending payment" state that holds a place for a few minutes and then releases it.
6. The booking page, confirmation email and staff Appointments page don't show quantity or amount.
7. Connect (CRM/POS/reservations integrations) has appointment sync but no quantity or payment fields.

## Proposal

### A. Capacity in people, not bookings (small)

- `Service.bookingUnit`: `BOOKING` (default, today's behaviour) or `PERSON` (seats/covers). `Service.minPartySize`, `maxPartySize`.
- `Appointment.partySize Int @default(1)`.
- `claimSlot(slotId, n)` becomes one atomic `UPDATE ... WHERE bookedCount + n <= capacity` and `releaseSlot` gives back `partySize`. Existing services keep `BOOKING`, so nothing changes for them.
- Booking page: a "How many?" stepper before the time picker (only when `bookingUnit = PERSON`); slots show only times with enough room; confirmation, email, manage page and Appointments table show the party size.
- Restaurants: capacity per slot = covers the room can seat. Optional later: named tables (a "Table" resource with seats, assigned at booking or by the host) using service points.

### B. Sessions for one-off events (small to medium)

- Staff create a **session**: a service, date and time, capacity, optional price. It is a normal `Slot` on that day's queue plus `Slot.label` and `Slot.price`, and it shows on the booking page alongside, or instead of, the recurring slots (`Service.slotMode`: `RECURRING`, `SESSIONS`, `BOTH`).
- Fits tickets, classes, tastings, tours and "chef's table" nights.

### C. Taking payment (the large piece)

Data: `Service.price`, `Service.currency`, `Service.paymentMode` (`NONE` default, `DEPOSIT`, `FULL`, `AT_VENUE`), `Service.depositAmount`; `Slot.price` overrides for sessions. On `Appointment`: `status` gains `PENDING_PAYMENT`, plus `amount`, `currency`, `paymentStatus`, `paymentProvider`, `paymentRef`, `paymentExpiresAt`.

Flow:
1. Customer picks time and party size, enters details, and is sent to the provider's hosted checkout. The place is held as `PENDING_PAYMENT` for about 10 minutes.
2. The provider webhook marks it paid and the booking confirmed; a daily-plus-frequent cron (`cron/frequent`) releases expired holds.
3. Cancellation follows a per-service policy (full refund until N hours before, then forfeit the deposit); refunds go through the same provider.
4. `AT_VENUE` keeps today's behaviour; a connected POS can clear the existing `awaitingClearance` gate when the bill is paid.

Where the money goes (**the decision needed**):

| Option | How | Good | Costs |
|---|---|---|---|
| 1. Organization's own keys | Each organization pastes its own Stripe or Paystack keys (stored encrypted like the platform's) | Simplest; the business owns the funds, payouts and disputes; works with any provider the adapter supports | No platform commission; the business sets up its own account |
| 2. Marketplace (Stripe Connect / Paystack subaccounts) | Organizations onboard an account under the platform's | Platform can take a fee; smoother onboarding | Compliance and KYC responsibility, per-country coverage, more moving parts |

Recommendation: ship option 1 first behind the same provider adapter (extend `PaymentProvider` with `createBookingCheckout`, `refund`, and a booking event in the webhook union, keyed by `paymentRef` and idempotent like the existing events), then add option 2 as another adapter if you want to take a fee.

### D. Integrations

Add `partySize`, `amount`, `currency`, `paymentStatus` to appointment objects and `appointment.*` webhooks (additive within Connect v1), and a way for a connected system to mark a booking paid.

## Suggested order

1. A (party size) + booking page/emails/staff table: about a day, no new integrations.
2. B (sessions): about a day, builds on A.
3. C (payments, option 1): the bulk of the work. Tests with mocked providers, then real test-mode keys.
4. D (Connect fields) alongside C.

## Questions for you

1. Who holds the money: each business's own Stripe/Paystack keys (option 1), or a marketplace account that lets the platform take a fee (option 2)?
2. Which currencies and providers matter first (Stripe, Paystack, mobile money)?
3. Should an unpaid hold last 10 minutes, or longer for bank-transfer style payments?
4. Default cancellation rule for deposits: full refund until how many hours before?
