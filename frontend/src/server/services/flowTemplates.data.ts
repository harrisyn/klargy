/**
 * The ready-made flows an admin can apply from the flow designer, one or more
 * per industry. Wording is deliberately neutral ("customer", "visit"): the app
 * says the organisation's own word for people wherever it shows them.
 */

export type PointType = 'RECEPTION' | 'TRIAGE' | 'CONSULTATION' | 'CASHIER' | 'PHARMACY' | 'LAB' | 'IMAGING' | 'OTHER';
export type BookingMode = 'WALK_IN' | 'APPOINTMENT' | 'BOTH';

export interface TemplateService {
  name: string;
  pointType: PointType;
  description: string;
  requiresClearance?: boolean;
  /** Minutes per slot / visit; the service default (15) when omitted. */
  slotDuration?: number;
  /** Whether the public page offers joining now, booking a time, or both. Walk-in when omitted. */
  bookingMode?: BookingMode;
  /** Bookings are for a number of people (covers, seats) rather than one place per booking. */
  partySize?: { min: number; max: number };
  /** Each booking is given a table or seat automatically, or the one the customer picks. Only where the industry has tables. */
  tableMode?: 'AUTO';
  /** Bookable only at sessions the business creates (an event or class), not at every day's hours. */
  sessionsOnly?: boolean;
}

export interface TemplateTable {
  name: string;
  seats: number;
  /** Centre on the room's floor plan. */
  x: number;
  y: number;
  width?: number;
  height?: number;
  shape?: 'RECT' | 'ROUND';
  rotation?: number;
}

/** A room the template sets up, with its floor plan. Tables are skipped for industries that don't have them. */
export interface TemplateRoom {
  name: string;
  description: string;
  layoutWidth?: number;
  layoutHeight?: number;
  minPartySize?: number;
  maxPartySize?: number;
  allowCombine?: boolean;
  tables: TemplateTable[];
}

export interface FlowTemplate {
  id: string;
  name: string;
  /** Industry ids from lib/terms.ts this suits; used to show the org's own first. */
  industries: string[];
  description: string;
  services: TemplateService[];
  /** from service name -> to service names, in priority order. */
  flows: Record<string, string[]>;
  /** The location's first point of contact (kiosk and QR joins). */
  defaultService: string;
  /** Rooms (and their tables or seats) to lay out. Existing rooms and tables of the same name are left as they are. */
  rooms?: TemplateRoom[];
}

/** A row of tables or seats at a height, evenly spaced from the left. */
function tableRow(prefix: string, from: number, count: number, o: { seats: number; x: number; y: number; step: number; width?: number; height?: number; shape?: 'RECT' | 'ROUND' }): TemplateTable[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}${from + i}`,
    seats: o.seats,
    x: o.x + i * o.step,
    y: o.y,
    width: o.width,
    height: o.height,
    shape: o.shape,
  }));
}

export const OUTPATIENT_TEMPLATE: FlowTemplate = {
  id: 'outpatient',
  name: 'Outpatient clinic',
  industries: ['HEALTHCARE'],
  description:
    'Reception, cashier, triage, consultation, laboratory, imaging and pharmacy in one waiting area. Consultation waits for payment.',
  services: [
    { name: 'Reception', pointType: 'RECEPTION', description: 'First point of contact: registration and the visit.' },
    { name: 'Cashier', pointType: 'CASHIER', description: 'Payments before consultation and for orders.' },
    { name: 'Triage', pointType: 'TRIAGE', description: 'Vital signs before seeing the doctor.' },
    { name: 'Consultation', pointType: 'CONSULTATION', requiresClearance: true, description: 'Seeing the doctor.' },
    { name: 'Laboratory', pointType: 'LAB', description: 'Samples and tests.' },
    { name: 'Imaging', pointType: 'IMAGING', description: 'X-ray, ultrasound and scans.' },
    { name: 'Pharmacy', pointType: 'PHARMACY', description: 'Medicines, then home.' },
  ],
  flows: {
    Reception: ['Cashier', 'Triage', 'Consultation', 'Laboratory', 'Pharmacy'],
    Cashier: ['Triage', 'Laboratory', 'Imaging', 'Pharmacy'],
    Triage: ['Consultation'],
    Consultation: ['Cashier', 'Laboratory', 'Imaging', 'Pharmacy'],
    Laboratory: ['Consultation', 'Pharmacy'],
    Imaging: ['Consultation'],
    Pharmacy: [],
  },
  defaultService: 'Reception',
};

export const RESTAURANT_TEMPLATE: FlowTemplate = {
  id: 'restaurant',
  name: 'Restaurant or café',
  industries: ['RESTAURANT'],
  description:
    'A waitlist at the host stand for walk-in parties, table reservations, then the bill. Takeaway orders have their own pick-up line.',
  services: [
    { name: 'Host stand', pointType: 'RECEPTION', description: 'Parties join the waitlist or arrive for a reservation.', bookingMode: 'BOTH', slotDuration: 90, partySize: { min: 1, max: 10 }, tableMode: 'AUTO' },
    { name: 'Dining', pointType: 'OTHER', description: 'Seated and served at a table.', slotDuration: 60 },
    { name: 'Takeaway pick-up', pointType: 'OTHER', description: 'Collect an order placed ahead.', slotDuration: 5 },
    { name: 'Bill', pointType: 'CASHIER', description: 'Paying before leaving.', slotDuration: 5 },
  ],
  flows: {
    'Host stand': ['Dining', 'Takeaway pick-up'],
    Dining: ['Bill'],
    'Takeaway pick-up': [],
    Bill: [],
  },
  defaultService: 'Host stand',
  rooms: [
    {
      name: 'Main dining',
      description: 'The main floor. Reservations are given the smallest table that fits the party.',
      tables: [
        ...tableRow('Table ', 1, 4, { seats: 2, x: 150, y: 130, step: 150, width: 70, height: 70, shape: 'ROUND' }),
        ...tableRow('Table ', 5, 3, { seats: 4, x: 170, y: 310, step: 200, width: 110, height: 80 }),
        { name: 'Table 8', seats: 6, x: 220, y: 500, width: 160, height: 90 },
      ],
    },
    {
      name: 'Terrace',
      description: 'Outdoors. Set a surcharge or opening hours on it if you want them.',
      tables: tableRow('Terrace ', 1, 4, { seats: 4, x: 160, y: 200, step: 200, width: 90, height: 90, shape: 'ROUND' }),
    },
    {
      name: 'Private room',
      description: 'One long table for groups.',
      minPartySize: 6,
      allowCombine: false,
      tables: [{ name: 'Private table', seats: 12, x: 500, y: 350, width: 360, height: 100 }],
    },
  ],
};

export const SALON_TEMPLATE: FlowTemplate = {
  id: 'salon',
  name: 'Salon, spa or studio',
  industries: ['SALON'],
  description:
    'Booked appointments for each treatment, with walk-ins welcome at reception. Arrive at your time, get your service, check out.',
  services: [
    { name: 'Reception', pointType: 'RECEPTION', description: 'Check in on arrival; walk-ins join here.', bookingMode: 'WALK_IN', slotDuration: 5 },
    { name: 'Hair', pointType: 'OTHER', description: 'Cuts, colour and styling. Clients can choose their chair.', bookingMode: 'BOTH', slotDuration: 45, partySize: { min: 1, max: 2 }, tableMode: 'AUTO' },
    { name: 'Beauty and spa', pointType: 'OTHER', description: 'Nails, facials, massage and treatments.', bookingMode: 'APPOINTMENT', slotDuration: 60 },
    { name: 'Checkout', pointType: 'CASHIER', description: 'Pay and rebook.', slotDuration: 5 },
  ],
  flows: {
    Reception: ['Hair', 'Beauty and spa'],
    Hair: ['Checkout'],
    'Beauty and spa': ['Checkout'],
    Checkout: [],
  },
  defaultService: 'Reception',
  rooms: [
    {
      name: 'Hair floor',
      description: 'The styling chairs. Two clients booking together are put side by side.',
      layoutWidth: 900,
      layoutHeight: 500,
      tables: [
        ...tableRow('Chair ', 1, 3, { seats: 1, x: 200, y: 140, step: 250, width: 70, height: 70, shape: 'ROUND' }),
        ...tableRow('Chair ', 4, 3, { seats: 1, x: 200, y: 340, step: 250, width: 70, height: 70, shape: 'ROUND' }),
      ],
    },
  ],
};

export const BANK_TEMPLATE: FlowTemplate = {
  id: 'bank-branch',
  name: 'Bank branch',
  industries: ['BANKING'],
  description:
    'A greeter sends customers to a teller or an advisor. Account opening and loans can be booked ahead; tellers are walk-in.',
  services: [
    { name: 'Welcome desk', pointType: 'RECEPTION', description: 'Greeting, forms and directing customers.', slotDuration: 5 },
    { name: 'Teller', pointType: 'CASHIER', description: 'Deposits, withdrawals and payments.', slotDuration: 10 },
    { name: 'Customer service', pointType: 'OTHER', description: 'Cards, statements and account queries.', bookingMode: 'BOTH', slotDuration: 15 },
    { name: 'Advisor', pointType: 'CONSULTATION', description: 'Loans, accounts and investments.', bookingMode: 'APPOINTMENT', slotDuration: 30 },
  ],
  flows: {
    'Welcome desk': ['Teller', 'Customer service', 'Advisor'],
    'Customer service': ['Teller', 'Advisor'],
    Advisor: ['Teller'],
    Teller: [],
  },
  defaultService: 'Welcome desk',
};

export const GOVERNMENT_TEMPLATE: FlowTemplate = {
  id: 'government-office',
  name: 'Government or licensing office',
  industries: ['GOVERNMENT'],
  description:
    'Information desk, document check, the service counter, payment of fees, then collection. The counter waits for documents and payment.',
  services: [
    { name: 'Information desk', pointType: 'RECEPTION', description: 'Which service and which documents.', slotDuration: 5 },
    { name: 'Document check', pointType: 'TRIAGE', description: 'Checking forms and identity.', bookingMode: 'BOTH', slotDuration: 10 },
    { name: 'Fees', pointType: 'CASHIER', description: 'Paying application fees.', slotDuration: 5 },
    { name: 'Service counter', pointType: 'CONSULTATION', requiresClearance: true, description: 'Applications, renewals and processing.', bookingMode: 'APPOINTMENT', slotDuration: 20 },
    { name: 'Collection', pointType: 'OTHER', description: 'Collecting finished documents.', slotDuration: 5 },
  ],
  flows: {
    'Information desk': ['Document check', 'Fees', 'Collection'],
    'Document check': ['Fees', 'Service counter'],
    Fees: ['Service counter', 'Collection'],
    'Service counter': ['Fees', 'Collection'],
    Collection: [],
  },
  defaultService: 'Information desk',
};

export const SERVICE_CENTRE_TEMPLATE: FlowTemplate = {
  id: 'service-centre',
  name: 'Shop or service centre',
  industries: ['RETAIL'],
  description:
    'Front desk, a technician or sales assistant, payment, and pick-up. Repairs and fittings can be booked; the counter is walk-in.',
  services: [
    { name: 'Front desk', pointType: 'RECEPTION', description: 'Check in, enquiries and drop-offs.', slotDuration: 5 },
    { name: 'Technician', pointType: 'OTHER', description: 'Repairs, fittings and set-up.', bookingMode: 'BOTH', slotDuration: 30 },
    { name: 'Payment', pointType: 'CASHIER', description: 'Paying for goods and services.', slotDuration: 5 },
    { name: 'Pick-up', pointType: 'OTHER', description: 'Collecting repaired or ordered items.', slotDuration: 5 },
  ],
  flows: {
    'Front desk': ['Technician', 'Payment', 'Pick-up'],
    Technician: ['Payment', 'Pick-up'],
    Payment: ['Pick-up'],
    'Pick-up': [],
  },
  defaultService: 'Front desk',
};

export const SCHOOL_TEMPLATE: FlowTemplate = {
  id: 'school-office',
  name: 'School or university office',
  industries: ['EDUCATION'],
  description: 'Enquiries, admissions or registry, then the finance office for fees. Admissions meetings can be booked.',
  services: [
    { name: 'Enquiries', pointType: 'RECEPTION', description: 'Questions and directing students and parents.', slotDuration: 5 },
    { name: 'Admissions', pointType: 'CONSULTATION', description: 'Applications and enrolment meetings.', bookingMode: 'BOTH', slotDuration: 20 },
    { name: 'Registry', pointType: 'OTHER', description: 'Records, transcripts and certificates.', slotDuration: 10 },
    { name: 'Finance office', pointType: 'CASHIER', description: 'Fees and payments.', slotDuration: 10 },
  ],
  flows: {
    Enquiries: ['Admissions', 'Registry', 'Finance office'],
    Admissions: ['Finance office', 'Registry'],
    Registry: ['Finance office'],
    'Finance office': [],
  },
  defaultService: 'Enquiries',
};

export const EVENT_VENUE_TEMPLATE: FlowTemplate = {
  id: 'event-venue',
  name: 'Class, workshop or event',
  industries: ['EDUCATION', 'OTHER'],
  description:
    'Check-in at the door and a seated session you schedule (a class, talk or screening). Guests book seats in a hall laid out in rows and can pick where they sit.',
  services: [
    { name: 'Check-in', pointType: 'RECEPTION', description: 'Arrivals are checked in here.', slotDuration: 5 },
    {
      name: 'Seated session',
      pointType: 'OTHER',
      description: 'Booked by seat. Add sessions with their dates and prices from the service.',
      bookingMode: 'APPOINTMENT',
      slotDuration: 90,
      partySize: { min: 1, max: 6 },
      tableMode: 'AUTO',
      sessionsOnly: true,
    },
  ],
  flows: { 'Check-in': ['Seated session'], 'Seated session': [] },
  defaultService: 'Check-in',
  rooms: [
    {
      name: 'Hall',
      description: 'Rows of seats. Edit the plan to match the real hall, and upload a picture of it behind the seats.',
      layoutWidth: 1000,
      layoutHeight: 640,
      tables: ['A', 'B', 'C', 'D'].flatMap((row, r) => tableRow(row, 1, 10, { seats: 1, x: 140, y: 150 + r * 90, step: 80, width: 44, height: 44, shape: 'ROUND' })),
    },
  ],
};

export const SINGLE_COUNTER_TEMPLATE: FlowTemplate = {
  id: 'single-counter',
  name: 'Single counter',
  industries: ['OTHER', 'RETAIL', 'RESTAURANT', 'SALON', 'BANKING', 'GOVERNMENT', 'EDUCATION', 'HEALTHCARE'],
  description: 'The simplest start for any business: one line, one service, customers join now or book a time.',
  services: [{ name: 'Service', pointType: 'RECEPTION', description: 'Everything in one place.', bookingMode: 'BOTH', slotDuration: 15 }],
  flows: { Service: [] },
  defaultService: 'Service',
};

export const FLOW_TEMPLATES: Record<string, FlowTemplate> = Object.fromEntries(
  [
    OUTPATIENT_TEMPLATE,
    RESTAURANT_TEMPLATE,
    SALON_TEMPLATE,
    BANK_TEMPLATE,
    GOVERNMENT_TEMPLATE,
    SERVICE_CENTRE_TEMPLATE,
    SCHOOL_TEMPLATE,
    EVENT_VENUE_TEMPLATE,
    SINGLE_COUNTER_TEMPLATE,
  ].map((t) => [t.id, t])
);
