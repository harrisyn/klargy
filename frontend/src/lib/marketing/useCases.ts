// Copy for the /use-cases pages. One entry per kind of business, each written
// around the search terms people in that business actually use (patient
// queue management, restaurant waitlist, bank queue system...). Every page
// has its own journey, example and questions so none is a near-copy of
// another. The example places and people are fictional and labelled so.
//
// Only describe what the product does today: the journeys match the flow
// templates in server/services/flowTemplates.data.ts.

export interface DeskRow {
  ticket: string;
  name: string;
  meta: string;
}

export interface UseCase {
  slug: string;
  /** Card and breadcrumb name. */
  name: string;
  /** Shown above the H1 and in the hub card. */
  eyebrow: string;
  metaTitle: string;
  metaDescription: string;
  title: string;
  lede: string;
  /** Hub card text. */
  summary: string;
  /** What the hero desk fragment shows. */
  desk: { title: string; waiting: string; rows: DeskRow[]; secondary: string; primary: string };
  pains: { title: string; text: string }[];
  journeyTitle: string;
  journey: { name: string; text: string }[];
  example: {
    name: string;
    kind: string;
    setting: string;
    before: string;
    after: string;
    changes: string[];
  };
  features: { title: string; text: string }[];
  faqs: { q: string; a: string }[];
  related: string[];
}

export const USE_CASES: UseCase[] = [
  {
    slug: 'clinics',
    name: 'Clinics',
    eyebrow: 'Patient queue management for clinics',
    metaTitle: 'Patient Queue Management System for Clinics',
    metaDescription:
      'Cut waiting room crowding with a clinic queue management system. Patients check in by QR code, wait anywhere and get a text when the doctor is ready.',
    title: 'A clinic queue system that empties the waiting room.',
    lede:
      'Patients check in with a QR code or at reception, see their place in line on their own phone, and get a text when the doctor is ready. Walk-ins and booked appointments share one fair list, from reception to the pharmacy.',
    summary: 'Walk-ins and appointments in one fair list, from reception to triage, the doctor and the pharmacy.',
    desk: {
      title: 'Consulting room 1',
      waiting: '5 waiting',
      rows: [
        { ticket: 'C021', name: 'Efua Asante', meta: 'With you for 6 min' },
        { ticket: 'C022', name: 'Kojo Darko', meta: 'Booked 09:40' },
        { ticket: 'C023', name: 'Abena Ofori', meta: 'Triage done' },
        { ticket: 'C024', name: 'Nii Lartey', meta: 'Waiting 11 min' },
      ],
      secondary: 'Send to lab',
      primary: 'Call next',
    },
    pains: [
      { title: 'A full waiting room all morning', text: 'Everyone arrives at opening time because nobody knows when they will be seen. Chairs fill up, tempers shorten, and sick and well patients sit side by side.' },
      { title: '"How much longer?" at the front desk', text: 'Reception spends the morning answering the same question instead of registering patients and handling payments.' },
      { title: 'Patients lost between rooms', text: 'After the doctor, patients queue again for the lab, then again for the pharmacy, and nobody can see who is waiting where.' },
    ],
    journeyTitle: 'One ticket from reception to the pharmacy',
    journey: [
      { name: 'Reception', text: 'The patient scans the QR code on the door or is checked in at the desk. Booked patients are placed by their appointment time.' },
      { name: 'Cashier', text: 'Patients pay or show cover before consultation. Unpaid patients are held back from the doctor list until they are cleared.' },
      { name: 'Triage', text: 'Nurses call the next patient for vitals, then send them on to the doctor without a new ticket.' },
      { name: 'Consultation', text: 'Each doctor calls from their own list in their own room. The room number goes up on the lobby screen.' },
      { name: 'Lab, imaging and pharmacy', text: 'The doctor sends the patient on with one tap. The patient sees where to go next on their phone.' },
    ],
    example: {
      name: 'Palmgrove Family Clinic',
      kind: 'a three-doctor family practice',
      setting:
        'Palmgrove opens at 8:00 and sees most of its patients before noon. Half are walk-ins, half have appointments, and almost everyone needs the lab or the pharmacy after seeing the doctor.',
      before:
        'Patients used to arrive at 7:30 to be near the front of a paper list. Booked patients complained that walk-ins went first, and the pharmacy had its own separate line with no idea who was coming.',
      after:
        'Now a QR code on the door issues a ticket and the patient can wait in the car or the café next door. Booked patients slot in by appointment time. When the doctor orders a test, they press "Send to lab" and the patient moves to the lab list, then on to the pharmacy, on the same ticket.',
      changes: [
        'Reception registers patients instead of answering "how long?"',
        'Doctors see who has finished triage before calling them',
        'The manager can see which hours need a second nurse at triage',
      ],
    },
    features: [
      { title: 'QR check-in and kiosk', text: 'A printed QR code at the entrance, or a tablet in kiosk mode for patients without a smartphone.' },
      { title: 'Appointments and walk-ins together', text: 'Online booking feeds the same list. Booked patients are placed by booked time, walk-ins fill the gaps.' },
      { title: 'Text, email and WhatsApp alerts', text: 'Patients get a message when they are nearly up and when they are called, so they can wait outside.' },
      { title: 'Rooms and desks', text: 'Each consulting room, triage station or counter calls from its own list.' },
      { title: 'Waiting room TV screen', text: 'Called numbers and rooms on any TV, with your own health messages playing between calls.' },
      { title: 'Connects to your records system', text: 'Send queue events to your EMR through the API, or run the desk inside a connected EMR.' },
    ],
    faqs: [
      { q: 'What is a patient queue management system?', a: 'It is software that issues each patient a ticket, keeps the order of who is next for each doctor or service, and tells the patient when it is their turn. It replaces paper lists and the crowd at reception with a live list staff can call from and patients can follow on their phone.' },
      { q: 'Can patients without a smartphone still join the queue?', a: 'Yes. Reception can check them in from the desk, or you can put a tablet in kiosk mode at the entrance. Their number is called on the waiting room screen like everyone else.' },
      { q: 'How do appointments and walk-ins share one queue?', a: 'Booked patients are placed in the list by their appointment time when they arrive, and walk-ins are served in arrival order around them. Each desk sees who is booked and who walked in.' },
      { q: 'Does it work with our electronic medical records system?', a: 'Klargy has an API and a connector for medical records systems, so queue events (joined, called, served, sent on) can flow into the patient record, and doctors can call patients without leaving the EMR.' },
    ],
    related: ['hospitals', 'pharmacies', 'banks'],
  },
  {
    slug: 'hospitals',
    name: 'Hospitals',
    eyebrow: 'Hospital queue management system',
    metaTitle: 'Hospital Queue Management System for Outpatients',
    metaDescription:
      'Move outpatients through registration, billing, triage, consultation, lab, imaging and pharmacy on one ticket. A hospital queue management system with live screens.',
    title: 'Outpatient flow for the whole hospital, on one ticket.',
    lede:
      'Hospitals are not one queue, they are ten. Klargy follows each outpatient from registration to billing, triage, the doctor, the lab, imaging and the pharmacy, so they never line up again from scratch and every department sees who is coming.',
    summary: 'Registration, billing, triage, consultation, lab, imaging and pharmacy, across departments and sites.',
    desk: {
      title: 'Laboratory',
      waiting: '9 waiting',
      rows: [
        { ticket: 'L044', name: 'Yaa Mensah', meta: 'Sample taken' },
        { ticket: 'L045', name: 'Kwesi Badu', meta: 'From Dr. Owusu' },
        { ticket: 'L046', name: 'Ama Sarpong', meta: 'From Dr. Quaye' },
        { ticket: 'L047', name: 'Fiifi Annan', meta: 'Waiting 14 min' },
      ],
      secondary: 'Send to imaging',
      primary: 'Call next',
    },
    pains: [
      { title: 'A new line at every department', text: 'Patients queue at records, again at billing, again at the doctor, again at the lab. Each line is invisible to the others.' },
      { title: 'No picture of where the day is stuck', text: 'Managers hear that "the lab is slow" but cannot see waits by department and hour, so staffing is a guess.' },
      { title: 'Unpaid patients reach the doctor', text: 'When payment and consultation are not linked, doctors see patients who have not been cleared and billing chases them later.' },
    ],
    journeyTitle: 'The outpatient journey, department by department',
    journey: [
      { name: 'Registration', text: 'New and returning patients are registered once. The ticket carries them through every department after that.' },
      { name: 'Billing', text: 'Patients pay or have their cover checked. Consultation can require clearance, so nobody unpaid reaches the doctor list.' },
      { name: 'Triage', text: 'Nurses take vitals and send the patient to the right clinic or doctor.' },
      { name: 'Consultation', text: 'Doctors call from their own room. A patient can be held while results come back and resumed later.' },
      { name: 'Lab and imaging', text: 'Tests are a step in the visit, not a new line. Each department sees who was sent and by whom.' },
      { name: 'Pharmacy', text: 'The last stop. When the patient is served, the visit closes and the time spent at each step is recorded.' },
    ],
    example: {
      name: 'Mercy Ridge District Hospital',
      kind: 'a 120-bed district hospital with two outpatient sites',
      setting:
        'Mercy Ridge runs a busy outpatient department at its main site and a smaller satellite clinic across town. Both share the lab, imaging and pharmacy teams.',
      before:
        'Patients carried paper folders from window to window. The lab had no idea how many patients the doctors had sent until they appeared at the door, and the morning pharmacy line spilled into the corridor.',
      after:
        'Each site is a location with its own queues and screens. The outpatient flow sends patients from registration through billing and triage to the doctor, and on to the lab, imaging or pharmacy. Department heads watch their own lists, and the operations manager compares both sites by hour.',
      changes: [
        'Every department sees who is on the way before they arrive',
        'Doctors can hold a patient waiting for results and resume them',
        'Waits by department and hour show where to add staff',
      ],
    },
    features: [
      { title: 'Patient journeys between services', text: 'Design the order of departments once. Staff send patients on with one tap and patients see their next stop.' },
      { title: 'Payment clearance before consultation', text: 'Mark consultation as needing clearance so only paid or covered patients enter the doctor list.' },
      { title: 'Multiple sites and departments', text: 'Run several locations, each with its own services, desks, rooms and lobby screens.' },
      { title: 'Lobby and department screens', text: 'Show called numbers with the room or counter on every TV, and play health messages between calls.' },
      { title: 'Analytics and audit log', text: 'Waits, service times and no-shows by department and hour, plus a record of every call and transfer.' },
      { title: 'EMR integration', text: 'Connect your hospital information system through the API so the queue follows the visit record.' },
    ],
    faqs: [
      { q: 'How is a hospital queue management system different from a clinic one?', a: 'A hospital runs many departments, often across several buildings or sites, and a single visit passes through several of them. Klargy handles that with locations, services per department and patient journeys that carry the same ticket from step to step.' },
      { q: 'Can we stop unpaid patients reaching the doctor?', a: 'Yes. A service such as consultation can require clearance. Patients join that list only after billing marks them as paid or covered.' },
      { q: 'Can a doctor pause a patient while waiting for results?', a: 'Yes. A patient can be put on hold and resumed later, so they keep their place with that doctor instead of starting again.' },
      { q: 'Do we need special hardware?', a: 'No. Any TV with a browser works as a display, any tablet works as a kiosk, and staff use the computers or phones they already have.' },
    ],
    related: ['clinics', 'pharmacies', 'government-offices'],
  },
  {
    slug: 'pharmacies',
    name: 'Pharmacies',
    eyebrow: 'Pharmacy queue management',
    metaTitle: 'Pharmacy Queue Management System and Prescription Line',
    metaDescription:
      'Shorten the prescription line. A pharmacy queue system that separates drop-off, consultation and collection, and texts customers when their medicine is ready.',
    title: 'Hand over prescriptions without a crowd at the counter.',
    lede:
      'Separate prescription drop-off, pharmacist consultations and collection into their own lines. Customers leave their prescription, do their shopping or go home, and get a text when their medicine is ready.',
    summary: 'Separate drop-off, consultation and collection, and text customers when their medicine is ready.',
    desk: {
      title: 'Collection counter',
      waiting: '4 waiting',
      rows: [
        { ticket: 'P031', name: 'Esi Owusu', meta: 'Ready to collect' },
        { ticket: 'P032', name: 'Kofi Agyei', meta: 'Ready to collect' },
        { ticket: 'P033', name: 'Adjoa Boateng', meta: 'Being prepared' },
        { ticket: 'P034', name: 'Edem Tetteh', meta: 'Waiting 4 min' },
      ],
      secondary: 'Send to pharmacist',
      primary: 'Call next',
    },
    pains: [
      { title: 'One line for everything', text: 'Someone collecting a ready prescription waits behind someone who needs ten minutes of advice.' },
      { title: 'Customers hovering at the counter', text: 'With no idea when their medicine will be ready, people stand at the counter and interrupt the team.' },
      { title: 'Peak hours that surprise you', text: 'Lunchtime and after-work rushes are felt but not measured, so the rota does not match the demand.' },
    ],
    journeyTitle: 'From drop-off to collection',
    journey: [
      { name: 'Drop-off', text: 'The customer hands in a prescription and gets a ticket on their phone or a printed number.' },
      { name: 'Pharmacist consultation', text: 'Customers who need advice are sent to the pharmacist list, without losing their place for collection.' },
      { name: 'Collection', text: 'When the order is ready, the customer is called to the collection counter by text and on screen.' },
    ],
    example: {
      name: 'Greenleaf Community Pharmacy',
      kind: 'a neighbourhood pharmacy next to a busy clinic',
      setting:
        'Greenleaf fills most of the prescriptions written at the clinic across the road, so its busy hours follow the clinic: mid-morning and just after lunch.',
      before:
        'Everyone waited in one line that ran to the door. Customers asked "is mine ready?" every few minutes, and quick collections waited behind long consultations.',
      after:
        'Drop-off, consultation and collection are now three services. Customers drop off and leave, get a text when their order is called, and the screen above the counter shows who to serve next.',
      changes: [
        'Quick collections no longer wait behind consultations',
        'Fewer people standing at the counter asking for updates',
        'The rota now matches the clinic’s busy hours',
      ],
    },
    features: [
      { title: 'Separate lines per service', text: 'Drop-off, consultation and collection each have their own list, counter and ticket prefix.' },
      { title: '"Ready" messages', text: 'Customers get a text, email or WhatsApp message when they are called, so they can shop or wait outside.' },
      { title: 'Hand-offs without a new ticket', text: 'Send a customer from drop-off to the pharmacist and on to collection on the same ticket.' },
      { title: 'Counter screen', text: 'Show called numbers on a TV above the counter, with your own promotions playing in between.' },
      { title: 'Peak-hour analytics', text: 'See arrivals and waits by hour and weekday, and ask plain-language questions about your numbers.' },
      { title: 'Works with a clinic', text: 'A clinic can send patients straight to the pharmacy list as the last step of their visit.' },
    ],
    faqs: [
      { q: 'How does a pharmacy queue system reduce waiting?', a: 'It splits work that takes very different amounts of time into separate lines, so quick collections are not stuck behind consultations, and it lets customers wait away from the counter until they are called.' },
      { q: 'Can we text customers when their prescription is ready?', a: 'Yes. When staff call the ticket, the customer gets a message by text, email or WhatsApp, depending on what you have turned on.' },
      { q: 'Do customers need to download an app?', a: 'No. They scan a QR code and the ticket opens in their phone’s browser. Customers without a phone get a number and watch the screen.' },
    ],
    related: ['clinics', 'hospitals', 'retail-and-service-centres'],
  },
  {
    slug: 'restaurants',
    name: 'Restaurants',
    eyebrow: 'Restaurant waitlist and table management',
    metaTitle: 'Restaurant Waitlist App: Virtual Waitlist & Reservations',
    metaDescription:
      'A virtual waitlist for restaurants. Guests join by QR code, wait at the bar or nearby and get a text when their table is ready. Reservations and tables in one place.',
    title: 'A restaurant waitlist that texts guests when their table is ready.',
    lede:
      'Guests join the waitlist by scanning a QR code at the door or at the host stand, see their place in line, and get a text when their table is ready. Reservations, walk-ins and your floor plan live in one place.',
    summary: 'A virtual waitlist, reservations and your floor plan together. Guests get a text when their table is ready.',
    desk: {
      title: 'Host stand',
      waiting: '7 parties waiting',
      rows: [
        { ticket: 'W012', name: 'Mensah, party of 4', meta: 'Table 6 ready' },
        { ticket: 'W013', name: 'Addo, party of 2', meta: 'Booked 19:30' },
        { ticket: 'W014', name: 'Quartey, party of 6', meta: 'Waiting 18 min' },
        { ticket: 'W015', name: 'Boakye, party of 2', meta: 'At the bar' },
      ],
      secondary: 'Seat on terrace',
      primary: 'Text: table ready',
    },
    pains: [
      { title: 'Guests who walk away', text: 'A crowd at the door and a vague "about 30 minutes" sends hungry guests to the place next door.' },
      { title: 'Paper lists and shouted names', text: 'Names get crossed out, parties are missed in the noise, and the host cannot tell who is still around.' },
      { title: 'Reservations and walk-ins in different places', text: 'The book says one thing, the floor says another, and tables sit empty while the line grows.' },
    ],
    journeyTitle: 'From the door to the bill',
    journey: [
      { name: 'Host stand', text: 'Parties join the waitlist with their party size, or check in for their reservation. Booked parties are given the smallest table that fits.' },
      { name: 'Dining', text: 'When a table is free, the host texts the party. The guest page shows "your table is ready" with the table name.' },
      { name: 'Takeaway pick-up', text: 'Orders placed ahead get their own line, so collection does not crowd the host stand.' },
      { name: 'Bill', text: 'Optional: call tables to pay at the counter during the busiest service.' },
    ],
    example: {
      name: 'Kettle & Coal',
      kind: 'a 70-cover grill house with a terrace',
      setting:
        'Kettle & Coal takes reservations for the dining room but keeps the terrace for walk-ins. Friday and Saturday evenings have a waitlist from 19:00 to 21:30.',
      before:
        'The host kept a clipboard and called names across a loud room. Parties gave up after twenty minutes, and the terrace sometimes had empty tables while the line waited inside.',
      after:
        'A QR code at the door adds parties to the waitlist with their size. Guests wait at the bar or take a walk, and the host texts them when a table opens. The floor plan shows the main dining room, the terrace and the private room, and reservations are seated automatically at the smallest table that fits.',
      changes: [
        'Fewer walk-aways: guests can see their place in line',
        'The bar is busier while guests wait',
        'Saturday covers are planned from real wait data',
      ],
    },
    features: [
      { title: 'Virtual waitlist', text: 'Guests join by QR code with their party size and follow their place in line on their phone.' },
      { title: '"Table ready" texts', text: 'Text, email or WhatsApp messages when a party is nearly up and when their table is ready.' },
      { title: 'Reservations and tables', text: 'Online booking with party sizes, rooms such as a terrace or private room, and tables on a floor plan.' },
      { title: 'Deposits for bookings', text: 'Take a deposit or full payment when guests book, with refund rules by how much notice they give.' },
      { title: 'Takeaway pick-up line', text: 'A separate line for collection orders so they do not crowd the host stand.' },
      { title: 'Busy-night analytics', text: 'Waits, table turns and no-shows by night and hour, to plan staff and covers.' },
    ],
    faqs: [
      { q: 'What is a virtual waitlist for restaurants?', a: 'A virtual waitlist replaces the clipboard at the host stand. Guests add themselves with a QR code, see their place in line on their phone, and get a text when their table is ready, so they do not have to stand at the door.' },
      { q: 'Do guests need to download an app to join the waitlist?', a: 'No. The waitlist opens in the phone’s browser after scanning the QR code. The host can also add parties by hand.' },
      { q: 'Can we manage reservations and walk-ins together?', a: 'Yes. Reservations come in through online booking and are given a table automatically, while walk-ins join the waitlist. The host sees both in one list.' },
      { q: 'Can we take deposits for reservations?', a: 'Yes. You can ask for a deposit or full payment at booking, and set refund tiers by how much notice the guest gives before cancelling.' },
    ],
    related: ['salons-and-barbershops', 'events-and-classes', 'retail-and-service-centres'],
  },
  {
    slug: 'salons-and-barbershops',
    name: 'Salons and barbershops',
    eyebrow: 'Salon and barbershop walk-in queue',
    metaTitle: 'Barbershop & Salon Walk-in Queue and Online Check-in',
    metaDescription:
      'Online check-in for barbershops and salons. Walk-ins join the line from their phone, pick their barber or stylist, and get a text when the chair is free.',
    title: 'Walk-ins welcome, without a crowded shop.',
    lede:
      'Clients check in online or at the door, choose their barber or stylist, and see how many are ahead of them. They get a text when the chair is free, so the shop stays calm and nobody loses their spot.',
    summary: 'Online check-in for walk-ins, chair choice and bookings, with a text when the chair is free.',
    desk: {
      title: 'Chair 3 · Kwabena',
      waiting: '3 waiting',
      rows: [
        { ticket: 'H018', name: 'Daniel', meta: 'In the chair 20 min' },
        { ticket: 'H019', name: 'Prince', meta: 'Booked 14:15' },
        { ticket: 'H020', name: 'Samuel', meta: 'Walk-in, any barber' },
        { ticket: 'H021', name: 'Ebo', meta: 'Waiting 9 min' },
      ],
      secondary: 'Send to checkout',
      primary: 'Call next',
    },
    pains: [
      { title: 'A packed bench on Saturday', text: 'Walk-ins fill every seat and spill outside, and some leave before you get to them.' },
      { title: '"Who’s next?" arguments', text: 'Without a list, the order is whoever speaks up, and regulars who asked for a particular barber get skipped.' },
      { title: 'Bookings and walk-ins colliding', text: 'A booked client arrives to find the chair taken by a walk-in, and the day runs late from there.' },
    ],
    journeyTitle: 'From check-in to checkout',
    journey: [
      { name: 'Check-in', text: 'Walk-ins join from the QR code at the door or from home before they leave. Booked clients check in on arrival.' },
      { name: 'The chair', text: 'Clients can pick a barber or stylist, or take the first one free. Each chair calls from its own list.' },
      { name: 'Treatments', text: 'Nails, colour or spa treatments can be booked as appointments with their own durations.' },
      { name: 'Checkout', text: 'Send the client to pay and rebook, on the same ticket.' },
    ],
    example: {
      name: 'Crown & Comb Barbershop',
      kind: 'a five-chair barbershop that is busiest on weekends',
      setting:
        'Crown & Comb takes bookings during the week, but Saturday is walk-in day and the shop is full from opening to close.',
      before:
        'On Saturdays the bench outside was the queue. Regulars waited for their favourite barber without anyone knowing, and some clients left after seeing the crowd.',
      after:
        'Clients now check in online before leaving home, choose a barber or "first available", and watch the line from their phone. Each barber calls the next client from their chair, and a TV by the door shows who is up.',
      changes: [
        'The bench is no longer the queue',
        'Regulars get their own barber without arguments',
        'Bookings keep their time even on walk-in days',
      ],
    },
    features: [
      { title: 'Online check-in for walk-ins', text: 'Clients join the line from home or at the door with a QR code. No app to install.' },
      { title: 'Choose your barber or stylist', text: 'Each chair can be picked by name, or clients take the first one free.' },
      { title: 'Bookings with deposits', text: 'Online appointments for longer treatments, with optional deposits and refund rules.' },
      { title: 'Chair-free texts', text: 'A text, email or WhatsApp message when the client is nearly up and when the chair is ready.' },
      { title: 'Shop TV', text: 'Show who is next and play your own promotions between calls.' },
      { title: 'Busy-day insights', text: 'See which days and hours need another barber, and how long each service really takes.' },
    ],
    faqs: [
      { q: 'How does online check-in work for a barbershop?', a: 'Clients scan a QR code or open your check-in link, enter their name and phone number, and join the line. They see how many people are ahead and get a text when it is nearly their turn.' },
      { q: 'Can clients choose a specific barber or stylist?', a: 'Yes. Each chair can be offered by name, and clients can choose one or take the first free chair.' },
      { q: 'Can we mix walk-ins with appointments?', a: 'Yes. Booked clients are placed by their booked time when they check in, and walk-ins are served around them.' },
    ],
    related: ['restaurants', 'retail-and-service-centres', 'events-and-classes'],
  },
  {
    slug: 'banks',
    name: 'Banks',
    eyebrow: 'Bank queue management system',
    metaTitle: 'Bank Queue Management System for Branches',
    metaDescription:
      'A bank branch queue system with tickets for tellers, customer service and advisors. Customers wait comfortably, appointments are honoured and every call is logged.',
    title: 'A branch where customers know when they will be served.',
    lede:
      'Customers take a ticket for the teller, customer service or an advisor, from a QR code or a kiosk at the welcome desk. Each counter calls from its own list, advisors keep their appointments, and every call is logged.',
    summary: 'Tickets for tellers, customer service and advisors, with appointments and a full audit trail.',
    desk: {
      title: 'Teller 2',
      waiting: '8 waiting',
      rows: [
        { ticket: 'T061', name: 'Akosua Frimpong', meta: 'With you for 3 min' },
        { ticket: 'T062', name: 'Joseph Amoah', meta: 'Waiting 7 min' },
        { ticket: 'T063', name: 'Mary Owusu', meta: 'Waiting 6 min' },
        { ticket: 'T064', name: 'Isaac Nyarko', meta: 'Waiting 4 min' },
      ],
      secondary: 'Send to advisor',
      primary: 'Call next',
    },
    pains: [
      { title: 'One long line for every task', text: 'A quick deposit waits behind a loan conversation because everything goes through one line.' },
      { title: 'Advisor appointments that slip', text: 'Customers who booked a meeting still wait in the hall because the advisor is pulled to the counter.' },
      { title: 'No record of service times', text: 'Head office asks for waiting times per branch and the branch has nothing but estimates.' },
    ],
    journeyTitle: 'Every branch service, in its own line',
    journey: [
      { name: 'Welcome desk', text: 'Staff greet customers, help with forms and issue a ticket for the right service. Customers can also take one from the QR code or kiosk.' },
      { name: 'Teller', text: 'Deposits, withdrawals and payments. Each teller calls the next customer and the counter number shows on screen.' },
      { name: 'Customer service', text: 'Cards, statements and account queries, walk-in or booked.' },
      { name: 'Advisor', text: 'Loans, accounts and investments by appointment, so advisors keep their schedule.' },
    ],
    example: {
      name: 'Northgate Savings, Market Street branch',
      kind: 'a busy city-centre branch with four tellers and two advisors',
      setting:
        'Market Street serves traders from the market next door. Month-end and market days bring long lines at the tellers, while advisors see customers by appointment.',
      before:
        'Customers stood in a single line that curved around the hall. Advisors were pulled onto the counter at peak times, and booked customers waited for them.',
      after:
        'Customers take a ticket for the teller, customer service or an advisor. Tellers call from their own lists, and the screen shows which counter to go to. Advisor appointments are booked online and placed by time when the customer arrives.',
      changes: [
        'Quick transactions move faster, separate from long ones',
        'Advisors keep their appointment times',
        'Waits and service times are reported for every branch',
      ],
    },
    features: [
      { title: 'Tickets by service', text: 'Separate lines for tellers, customer service and advisors, with their own ticket prefixes.' },
      { title: 'Kiosk and QR code', text: 'A tablet in kiosk mode at the welcome desk, or a QR code customers scan with their own phone.' },
      { title: 'Advisor appointments', text: 'Customers book a meeting online and are placed by their booked time when they arrive.' },
      { title: 'Branch screens', text: 'Called numbers and counters on any TV, with your product messages between calls.' },
      { title: 'Audit log', text: 'Every call, transfer and cancellation is recorded with the staff member and time.' },
      { title: 'Multi-branch reporting', text: 'Compare waits and service times across branches by hour and weekday.' },
    ],
    faqs: [
      { q: 'What does a bank queue management system do?', a: 'It issues each customer a ticket for the service they need, keeps a separate list for each counter or advisor, calls customers to the right counter, and records how long each step took.' },
      { q: 'Can customers book an appointment with an advisor?', a: 'Yes. Advisor services can be booked online. When the customer arrives they check in and are placed by their booked time.' },
      { q: 'Can head office see all branches?', a: 'Yes. Each branch is a location in one organization, and analytics can be compared across locations.' },
    ],
    related: ['government-offices', 'retail-and-service-centres', 'hospitals'],
  },
  {
    slug: 'government-offices',
    name: 'Government offices',
    eyebrow: 'Government office queue system',
    metaTitle: 'Government Office Queue System for Licensing & Permits',
    metaDescription:
      'A queue system for government, licensing and permit offices. Information desk, document checks, fees and service counters on one ticket, with bookable slots.',
    title: 'Public services without the all-day line.',
    lede:
      'Licensing, permit and civil registry offices handle many steps per visit. Klargy gives each visitor one ticket for the information desk, document check, fees and the service counter, and lets them book a slot ahead.',
    summary: 'Information desk, document check, fees and service counters on one ticket, with bookable slots.',
    desk: {
      title: 'Service counter 4',
      waiting: '12 waiting',
      rows: [
        { ticket: 'S102', name: 'Grace Ansah', meta: 'Booked 10:20' },
        { ticket: 'S103', name: 'Ebenezer Kumi', meta: 'Fees paid' },
        { ticket: 'S104', name: 'Comfort Dapaah', meta: 'Documents checked' },
        { ticket: 'S105', name: 'Richard Osei', meta: 'Waiting 22 min' },
      ],
      secondary: 'Send to collection',
      primary: 'Call next',
    },
    pains: [
      { title: 'Lines that start before opening', text: 'Visitors arrive at dawn to be seen at all, then wait most of the day.' },
      { title: 'Wrong documents, wasted visits', text: 'Visitors reach the counter after hours of waiting only to be sent away for a missing form.' },
      { title: 'Pressure to show improvement', text: 'Service charters promise shorter waits, but there is no data to show whether they are met.' },
    ],
    journeyTitle: 'A visit in clear steps',
    journey: [
      { name: 'Information desk', text: 'Visitors are told which service and which documents they need, and given a ticket.' },
      { name: 'Document check', text: 'Forms and identity are checked first, so visitors are not turned away at the counter.' },
      { name: 'Fees', text: 'Application fees are paid before processing. The service counter can require clearance.' },
      { name: 'Service counter', text: 'Applications, renewals and processing, by booked slot or walk-in.' },
      { name: 'Collection', text: 'Visitors return to collect finished documents in their own short line.' },
    ],
    example: {
      name: 'Riverside Municipal Licensing Office',
      kind: 'a city office for business permits and driving licence renewals',
      setting:
        'Riverside processes business permits and licence renewals for the whole district. Mondays and the last week of each month are the busiest.',
      before:
        'Visitors queued outside from 6:00. Many waited three hours to learn their forms were incomplete, and the office could not say how long a renewal took on average.',
      after:
        'Visitors now book a slot online or take a ticket at the information desk. Document checks happen first, fees are cleared before the counter, and visitors follow their ticket on their phone. The lobby screens show which counter to go to.',
      changes: [
        'Fewer visitors sent away at the counter for missing documents',
        'Booked slots spread demand across the week',
        'Monthly reports of waiting and service times',
      ],
    },
    features: [
      { title: 'Multi-step visits', text: 'One ticket follows the visitor from the information desk to collection.' },
      { title: 'Book a slot', text: 'Visitors book a time for the service counter, and walk-ins are served around them.' },
      { title: 'Fees before processing', text: 'A counter can require clearance from the fees desk before visitors join its list.' },
      { title: 'Public display screens', text: 'Large called numbers and counter names on every screen, with public notices in between.' },
      { title: 'Kiosk for walk-ins', text: 'Visitors without a phone take a ticket at a kiosk and follow the screens.' },
      { title: 'Reporting and audit', text: 'Waiting and service times by service and counter, and a full audit log for accountability.' },
    ],
    faqs: [
      { q: 'How can a government office reduce waiting times?', a: 'Spread arrivals with bookable slots, check documents before the main counter so visits are not wasted, separate quick tasks like collection from long ones, and measure waits so staffing follows demand.' },
      { q: 'Can visitors without smartphones use it?', a: 'Yes. A kiosk at the entrance prints or shows a ticket number, staff can issue tickets at the information desk, and numbers are called on the screens.' },
      { q: 'Is every action recorded?', a: 'Yes. Calls, transfers and cancellations are kept in an audit log with the staff member and time.' },
    ],
    related: ['banks', 'schools-and-universities', 'hospitals'],
  },
  {
    slug: 'retail-and-service-centres',
    name: 'Retail and service centres',
    eyebrow: 'Retail queue management',
    metaTitle: 'Retail Queue Management for Stores & Service Centres',
    metaDescription:
      'Queue management for shops, telecom stores and repair centres. Check in at the front desk, wait anywhere, and get called for the technician, payment or pick-up.',
    title: 'Let customers shop while they wait.',
    lede:
      'Phone shops, telecom stores, repair and service centres: customers check in at the front desk or with a QR code, browse or step out, and get a text when the technician, payment desk or pick-up counter is ready for them.',
    summary: 'Front desk, technicians, payment and pick-up for stores, telecom shops and repair centres.',
    desk: {
      title: 'Technician bench',
      waiting: '6 waiting',
      rows: [
        { ticket: 'R027', name: 'Selasi Agbeko', meta: 'Screen repair' },
        { ticket: 'R028', name: 'Nana Ama Poku', meta: 'Booked 11:00' },
        { ticket: 'R029', name: 'Kwame Asare', meta: 'SIM swap' },
        { ticket: 'R030', name: 'Linda Acheampong', meta: 'Waiting 8 min' },
      ],
      secondary: 'Send to pick-up',
      primary: 'Call next',
    },
    pains: [
      { title: 'Customers stuck in a line, not in the store', text: 'People who could be browsing are standing still, and some leave without buying.' },
      { title: 'Repairs and quick tasks in one line', text: 'A two-minute top-up waits behind a thirty-minute repair.' },
      { title: 'Drop-offs nobody can track', text: 'Customers call to ask whether their device is ready because they cannot see it themselves.' },
    ],
    journeyTitle: 'From the front desk to pick-up',
    journey: [
      { name: 'Front desk', text: 'Check-in, enquiries and drop-offs. Customers get a ticket for the right service.' },
      { name: 'Technician', text: 'Repairs, fittings and set-up, walk-in or booked.' },
      { name: 'Payment', text: 'Customers are sent to pay on the same ticket.' },
      { name: 'Pick-up', text: 'Repaired or ordered items are collected from their own short line, with a text when ready.' },
    ],
    example: {
      name: 'Circuit Square Mobile Service Centre',
      kind: 'a phone and telecom service centre in a shopping mall',
      setting:
        'Circuit Square handles SIM registrations, top-ups, device repairs and order pick-ups. Weekends and lunchtimes are packed.',
      before:
        'One line for everything stretched into the mall corridor. Customers waiting for repairs blocked the counter for people who only needed a SIM swap.',
      after:
        'Customers check in at the front desk or with a QR code and wait anywhere in the mall. Quick tasks, repairs and pick-ups have their own lines, and customers get a text when it is their turn.',
      changes: [
        'The corridor is clear on Saturdays',
        'Quick tasks are served in minutes',
        'Repair customers know when to come back',
      ],
    },
    features: [
      { title: 'Wait anywhere', text: 'Customers follow their ticket on their phone and get a text when they are nearly up.' },
      { title: 'Lines by task', text: 'Separate quick tasks, repairs, payment and pick-up so each moves at its own pace.' },
      { title: 'Book a technician', text: 'Customers book a repair slot online and are placed by time when they arrive.' },
      { title: 'Store screens with your promotions', text: 'Called numbers plus your own images and videos, so the wait sells for you.' },
      { title: 'Several stores, one account', text: 'Run every branch as a location with its own lines and screens.' },
      { title: 'Know your busy hours', text: 'Arrivals, waits and service times by store, hour and weekday.' },
    ],
    faqs: [
      { q: 'What is retail queue management?', a: 'It is a way of managing in-store lines so customers do not have to stand in them. They take a ticket, keep shopping or step out, and are called when a staff member is ready.' },
      { q: 'Can we use our lobby screens for promotions?', a: 'Yes. Upload images and videos and set when each campaign runs. When a number is called, the queue takes over the screen.' },
      { q: 'Does it work across many stores?', a: 'Yes. Each store is a location with its own services, desks and screens, all managed from one organization.' },
    ],
    related: ['banks', 'pharmacies', 'salons-and-barbershops'],
  },
  {
    slug: 'schools-and-universities',
    name: 'Schools and universities',
    eyebrow: 'Student services queue management',
    metaTitle: 'Student Services Queue for Schools & Universities',
    metaDescription:
      'Queue management for admissions, registry and finance offices. Students and parents check in online, book meetings and wait anywhere on campus.',
    title: 'Registration week, without the corridor queue.',
    lede:
      'Admissions, registry and finance offices are swamped at the start of every term. Students and parents check in with a QR code, book admissions meetings, and wait anywhere on campus until they are called.',
    summary: 'Admissions, registry and finance offices: check in online, book meetings and wait anywhere on campus.',
    desk: {
      title: 'Registry window 1',
      waiting: '15 waiting',
      rows: [
        { ticket: 'R210', name: 'Akua Mensah', meta: 'Transcript request' },
        { ticket: 'R211', name: 'Yaw Ofori', meta: 'Waiting 12 min' },
        { ticket: 'R212', name: 'Selorm Kpodo', meta: 'Waiting 10 min' },
        { ticket: 'R213', name: 'Dela Ahiable', meta: 'Waiting 8 min' },
      ],
      secondary: 'Send to finance',
      primary: 'Call next',
    },
    pains: [
      { title: 'The start-of-term rush', text: 'Hundreds of students need the same office in the same week, and the corridor becomes the waiting room.' },
      { title: 'Office to office', text: 'Students are sent from registry to finance and back, joining a new line each time.' },
      { title: 'Parents and applicants on visits', text: 'Families travelling for admissions meetings wait with everyone else.' },
    ],
    journeyTitle: 'Student services in sequence',
    journey: [
      { name: 'Enquiries', text: 'Questions and directing students and parents to the right office.' },
      { name: 'Admissions', text: 'Applications and enrolment meetings, which families can book ahead.' },
      { name: 'Registry', text: 'Records, transcripts and certificates.' },
      { name: 'Finance office', text: 'Fees and payments, on the same ticket.' },
    ],
    example: {
      name: 'Eastbrook University',
      kind: 'a university of 9,000 students',
      setting:
        'Eastbrook’s registry, admissions and finance offices share one building. The first two weeks of each semester are the busiest of the year.',
      before:
        'Students waited in the corridor for hours, missed lectures, and were sent from registry to finance and back. Families for admissions interviews had no fixed time.',
      after:
        'Students scan a QR code, join the right line and go to class or the library. They get a text when they are nearly up. Admissions meetings are booked online, and the registry can send students to finance on the same ticket.',
      changes: [
        'Corridors stay clear during registration week',
        'Families arrive for a booked admissions time',
        'Each office can see its busiest days of the term',
      ],
    },
    features: [
      { title: 'Join from anywhere on campus', text: 'Students join by QR code or link and get a text when they are nearly up.' },
      { title: 'Bookable meetings', text: 'Admissions and advising meetings booked online, placed by time on arrival.' },
      { title: 'Office-to-office transfers', text: 'Send a student from registry to finance without a new ticket.' },
      { title: 'Seated sessions', text: 'For exams, orientation or open days, book people into seats on a hall plan.' },
      { title: 'Screens in every office', text: 'Called numbers and windows on screen, with campus announcements in between.' },
      { title: 'Term-by-term insights', text: 'Waits and volumes by office and week, to plan staffing for the next rush.' },
    ],
    faqs: [
      { q: 'How do universities manage registration queues?', a: 'By letting students join the line remotely and wait elsewhere, separating services such as registry and finance into their own lines, and offering bookable times for longer meetings like admissions.' },
      { q: 'Can students be sent from one office to another?', a: 'Yes. Staff send the student on with one tap and they keep the same ticket.' },
      { q: 'Can we use it for open days or orientation?', a: 'Yes. Seated sessions let people book a seat in a hall, and check-in works on arrival.' },
    ],
    related: ['government-offices', 'events-and-classes', 'banks'],
  },
  {
    slug: 'events-and-classes',
    name: 'Events and classes',
    eyebrow: 'Event check-in and seat booking',
    metaTitle: 'Event Check-in and Seat Booking for Classes & Workshops',
    metaDescription:
      'Seat booking and check-in for classes, workshops and events. Sell seats on a hall plan, take payments and check people in at the door with a queue.',
    title: 'Seats booked, doors open, no clipboard.',
    lede:
      'Classes, workshops, talks and small events: people book a seat on your hall plan, pay ahead if you want, and check in at the door. Late arrivals and walk-ups join a short line instead of a crowd.',
    summary: 'Book seats on a hall plan, take payments and check people in at the door.',
    desk: {
      title: 'Check-in',
      waiting: '11 arriving',
      rows: [
        { ticket: 'E041', name: 'Abena Kyei', meta: 'Row B, seat 4' },
        { ticket: 'E042', name: 'Kofi Ntim', meta: 'Row B, seat 5' },
        { ticket: 'E043', name: 'Mawuli Dzah', meta: 'Paid at door' },
        { ticket: 'E044', name: 'Afia Sarfo', meta: 'Row D, seat 1' },
      ],
      secondary: 'Walk-up seat',
      primary: 'Check in',
    },
    pains: [
      { title: 'A crush at the door', text: 'Everyone arrives at the same time and the check-in desk becomes a bottleneck.' },
      { title: 'Seats double-booked or unclear', text: 'Spreadsheets and paper lists lead to two people in one seat, or empty seats that were "taken".' },
      { title: 'Chasing payments', text: 'Collecting fees at the door slows everything down and leaves gaps when people do not show.' },
    ],
    journeyTitle: 'Booking to the door',
    journey: [
      { name: 'Booking', text: 'People pick a session and a seat on your hall plan, and pay in full or a deposit.' },
      { name: 'Check-in', text: 'At the door, people are checked in by name or ticket. Walk-ups join a short line.' },
      { name: 'Seated session', text: 'Everyone has a seat. Add sessions with their own dates and prices.' },
    ],
    example: {
      name: 'The Lantern Hall',
      kind: 'a 120-seat community hall that runs evening classes and talks',
      setting:
        'The Lantern Hall hosts cooking classes, talks and small concerts. Most sessions sell out, and doors open fifteen minutes before the start.',
      before:
        'Bookings arrived by phone and messages, seats were tracked on a spreadsheet, and fifteen minutes was never enough to check everyone in.',
      after:
        'Each session is booked online by seat on a plan of the hall, with payment taken at booking. At the door, staff check people in from one list and walk-ups join a short line for remaining seats.',
      changes: [
        'No more double-booked seats',
        'Payments are collected before the night',
        'Doors-to-start check-in fits in fifteen minutes',
      ],
    },
    features: [
      { title: 'Seat maps', text: 'Draw your room with rows of seats and upload a picture of the real hall behind them.' },
      { title: 'Sessions with prices', text: 'Add sessions with their own dates and prices from the service.' },
      { title: 'Payments and refunds', text: 'Take full payment or a deposit at booking, with refund tiers by notice.' },
      { title: 'Fast check-in', text: 'Check people in from one list at the door, with a queue for walk-ups.' },
      { title: 'Reminders', text: 'Booking confirmations and reminders by email, text or WhatsApp.' },
      { title: 'Your brand', text: 'Your logo and colours on the booking page, with your own web address.' },
    ],
    faqs: [
      { q: 'Can people choose their own seat?', a: 'Yes. Seats can be picked on the hall plan when booking, or given automatically.' },
      { q: 'Can we take payment when people book?', a: 'Yes. Ask for full payment or a deposit, and set refund tiers by how much notice is given.' },
      { q: 'What about people who turn up without booking?', a: 'Walk-ups join the check-in line and can be seated in any remaining seats.' },
    ],
    related: ['restaurants', 'schools-and-universities', 'salons-and-barbershops'],
  },
];

export function findUseCase(slug: string): UseCase | undefined {
  return USE_CASES.find((u) => u.slug === slug);
}

/** Questions for the /use-cases hub, aimed at the general search terms. */
export const GENERAL_FAQS: { q: string; a: string }[] = [
  { q: 'What is a queue management system?', a: 'A queue management system is software that organises who is next. People take a ticket (by QR code, kiosk or at a desk), see their place in line and estimated wait, and are called to a counter, room or table when it is their turn. Staff call from a live list, and managers see waiting and service times.' },
  { q: 'What is a virtual queue?', a: 'A virtual queue lets people hold their place without standing in a physical line. They join from their phone, wait wherever they like, and get a message when they are nearly up.' },
  { q: 'Do customers need to install an app?', a: 'No. Klargy tickets open in the phone’s web browser after scanning a QR code. Staff can also issue tickets at the desk, and a tablet can run as a kiosk.' },
  { q: 'What hardware do I need?', a: 'None beyond what you have. Staff use any computer, tablet or phone. Any TV with a browser can be the lobby screen. A printed QR code is enough to start.' },
  { q: 'How much does a queue management system cost?', a: 'Klargy has a free plan for one location, and paid plans priced per organization. If your size or budget does not fit a plan, we agree a fee with you. See the pricing page.' },
  { q: 'Can it handle appointments as well as walk-ins?', a: 'Yes. Online booking feeds the same lists. Booked people are placed by their booked time when they arrive, and walk-ins are served around them.' },
];
