# Running an outpatient journey

One outpatient visit, one waiting area: the patient checks in at Reception,
pays at the Cashier when the consultation isn't paid yet, has their vitals
taken at Triage, sees the doctor, then goes on to the Laboratory, Imaging or
Pharmacy, and back to the doctor for a review or home. This guide sets that
up in Klargy, explains what staff and patients see at each step, and what an
EMR does through Klargy Connect.

The API details are in [Klargy Connect v1, section 9](../connect/v1.md#9-the-patient-journey-phase-6).

## 1. Apply the template

In **Admin → Flow designer**, choose the location and press **Use a
template**, then **Outpatient clinic**. It creates whatever is missing and
reuses what already exists, matching by name (so an existing "Cashier"
service is kept as it is). Applying it again changes nothing.

It sets up:

| Service | Service point | Notes |
| --- | --- | --- |
| Reception | Reception | The location's first point of contact |
| Cashier | Cashier | |
| Triage | Triage | |
| Consultation | Consultation | Waits for payment (see section 3) |
| Laboratory | Laboratory | |
| Imaging | Imaging | |
| Pharmacy | Pharmacy | The last stop |

The flow (where each service can send people next):

| From | To |
| --- | --- |
| Reception | Cashier, Triage, Consultation, Laboratory, Pharmacy |
| Cashier | Triage, Laboratory, Imaging, Pharmacy |
| Triage | Consultation |
| Consultation | Cashier, Laboratory, Imaging, Pharmacy |
| Laboratory | Consultation, Pharmacy |
| Imaging | Consultation |
| Pharmacy | Nothing: the patient goes home |

You can change any of it afterwards in the flow designer, the service's
settings and the location's settings, like anything you set up by hand.

## 2. Counters, rooms and logins

Each service point starts with one desk. In **Admin → Service points**, set
how many each one has: one per reception counter, one per cashier window,
and one per consulting room (one per doctor on duty).

Give each person a Klargy login with the role that fits:

| Who | Role | Signs in to |
| --- | --- | --- |
| Receptionists | Receptionist | A Reception counter |
| Cashiers | Service staff | A Cashier window |
| Triage nurses | Service staff | A Triage desk |
| Doctors | Service staff | Their consulting room |
| Lab, imaging and pharmacy staff | Service staff | Their desk |
| The clinic manager | Location admin | Any; manages settings |

Each person picks their desk when they open the desk (or the EMR does it for
them when the desk is embedded). Calls go to the desk they are signed in to.
When the EMR is connected, map each staff member to their EMR user so the
EMR can call patients into their room (section 7).

## 3. The payment gate

Consultation is set to **Wait for payment before they can be called** (in
the service's settings). A patient who joins Consultation without the
consultation being paid is **awaiting payment**:

- Desks show them with an "Awaiting payment" badge, below the patients who
  can be called. **Call next** skips them, and calling them is refused.
- The cashier (or anyone at a desk) presses **Mark paid**, or the EMR
  clears them when the bill is paid. They then join the line by when they
  arrived, not at the back.
- Their status page says they need to pay first, and shows no position.

Turn the setting on for any other service that should wait for payment.

## 4. Booked patients on arrival

A patient with an appointment who checks in on time takes their place in
line by their booked time, not at the back behind everyone who walked in
while they were on their way. It applies however they check in: from the
EMR (a ticket issued with the appointment, `refs.appointment`) or by staff
pressing **Check in** on the appointment in Klargy.

With the default settings (**Admin → Settings → Booked arrivals**):

- **On time** is from 10 minutes before to 15 minutes after the booked time.
  A patient booked for 10:30 who arrives at 10:20 waits behind everyone who
  arrived before 10:30 and ahead of anyone arriving after; arriving at 10:40
  they go ahead of the walk-ins who arrived between 10:30 and 10:40.
- **Late** (after 10:45 for a 10:30 booking) or very early (before 10:20):
  they join by arrival, like a walk-in.
- **Nobody already called is passed**, priority still comes first, and
  dragging the line into a different order at the desk wins over booked
  time.
- **Walk-ins keep moving**: at most one booked patient who arrived after a
  waiting walk-in goes ahead of them before that walk-in is next ("Half").
  Choose two or three per walk-in, no limit, or none.

You can switch it off, or change the window and the share. Switched off,
booked patients checked in by staff go ahead of walk-ins (as before), and
those checked in from the EMR join by arrival.

The desk list and **Call a specific patient** show a **Booked 10:30** chip
(hover for whether they were placed by it), and so does the patient's status
page. Call next, positions, "your turn is close" messages and the lobby
screen all follow the same order.

## 5. At the desk

The desk bar has, besides Call next, Complete, Send on and No show:

- **Hold**: the patient steps out (for a sample, an X-ray or a payment) and
  the room is free for the next patient. They keep their place at the front
  of the line, marked "On hold", and Call next doesn't pick them. **Call
  back** brings them back to the room and tells them again.
- **Call a specific patient** (the arrow beside Call next): the whole line,
  including people on hold and awaiting payment, to call one patient out of
  order, call someone back or mark them paid.
- **Send on**: complete the patient here and send them to one of the next
  steps in the flow.

A patient sent back to a service they have already been to (say, back to
Consultation after the laboratory) returns to the room that saw them: Call
next in that room picks them first, and the other rooms skip them while that
room is staffed.

## 6. What patients see

Patients join at the kiosk or by scanning the location's QR code. With no
service chosen, they join the first point of contact (Reception). Their
status page shows their ticket, their place and when it's their turn, and:

- **On hold** or **awaiting payment**, when that applies, with what to do.
- **Sent to** the next service, with a link to follow their new ticket,
  once someone sends them on.
- **Your visit today**: the stops so far and where they are now.
- **I'm done here**, once they have been seen at a stop: the next steps the
  flow offers from here ("Only pick a step the staff here asked you to go
  to") and **I'm leaving**. Picking a step moves their ticket there, through
  the payment gate. While still waiting, they only get **I'm leaving**.

Only the ticket's own status link can do this, and only a few times per
ticket.

## 7. The EMR side

An EMR connected through [Klargy Connect](../connect/guide.md) follows and
drives the same journey:

- **Check-in**: the EMR issues the Consultation ticket with `"cleared": true`
  when the consultation is paid, without it otherwise. When the bill is paid
  later it calls `clear` on the visit's ticket. For a booked patient it sends
  `refs.appointment` (after sending the appointment with `PUT
  /appointments`), so an on-time patient is placed by booked time (section 4).
- **Reception**: when a receptionist starts the visit in the EMR for the
  walk-in they are serving, the EMR calls `POST /entries/serving/link` to
  link that ticket to the EMR's patient and visit.
- **Consulting room**: the doctor calls the patient from the encounter with
  `call` and `staff`, which calls into the room they are signed in to. To
  check which room that is (say, when the EMR missed a `servicepoint.opened`
  webhook), it asks `GET /staff/{staffRef}/desk`.
  `hold` and `resume` do the same as the desk buttons.
- **Ending a step**: `transfer` sends the patient on (orders to the lab,
  prescriptions to the pharmacy); `complete` ends the visit.
- **Webhooks**: `entry.transferred` carries `from` with the encounter the
  patient just left, so the EMR can close it when someone sends the patient
  on from the desk or the patient moves themselves on (`sentBy` says who).
  `entry.held`, `entry.resumed` and `entry.cleared` report the rest.
- **The embedded desk** posts `klargy:entry-updated` on hold and call back,
  with `held` and `awaitingClearance` on the entry.

```ts
await klargy.createEntry({ service: 'CLIN-GP', refs: { patient: p.id, visit: v.id }, cleared: paid });
await klargy.clearEntry('visit', v.id);
await klargy.callEntry('visit', v.id, { staff: doctor.id });
await klargy.holdEntry('visit', v.id);
await klargy.linkServingEntry({ staff: receptionist.id, refs: { patient: p.id, visit: v.id } });
```
