/**
 * What an organization calls the people in its queues. A hospital has
 * patients, a restaurant has guests, a bank has customers. Shared by the
 * browser and the server (emails, SMS, AI answers) so copy stays consistent.
 */

export const INDUSTRIES = [
  { id: 'HEALTHCARE', label: 'Hospital or clinic', person: 'patient' },
  { id: 'RESTAURANT', label: 'Restaurant or café', person: 'guest' },
  { id: 'RETAIL', label: 'Shop or service centre', person: 'customer' },
  { id: 'BANKING', label: 'Bank or finance', person: 'customer' },
  { id: 'GOVERNMENT', label: 'Government office', person: 'visitor' },
  { id: 'EDUCATION', label: 'School or university', person: 'student' },
  { id: 'SALON', label: 'Salon, spa or studio', person: 'client' },
  { id: 'OTHER', label: 'Something else', person: 'customer' },
] as const;

export type IndustryId = (typeof INDUSTRIES)[number]['id'];

/**
 * Advanced features that only make sense for some kinds of business. They are
 * offered according to the organization's industry, so a clinic never sees
 * tables or floor plans and a restaurant does. Rooms (grouping desks, with
 * their own rules and rates) suit every industry. `OTHER` (and an unset
 * industry) gets everything, since we can't guess.
 */
export interface IndustryFeatures {
  /** Rooms within a location, each with its own rules and rates. */
  rooms: boolean;
  /** Named tables/chairs/seats that bookings are given, placed on a floor plan. */
  tables: boolean;
  /** What the bookable thing is called. */
  tableLabel: string;
  tablesLabel: string;
  roomLabel: string;
  roomsLabel: string;
}

const FEATURES: Record<string, IndustryFeatures> = {
  RESTAURANT: { rooms: true, tables: true, tableLabel: 'table', tablesLabel: 'tables', roomLabel: 'room', roomsLabel: 'rooms' },
  SALON: { rooms: true, tables: true, tableLabel: 'chair', tablesLabel: 'chairs', roomLabel: 'room', roomsLabel: 'rooms' },
  EDUCATION: { rooms: true, tables: true, tableLabel: 'seat', tablesLabel: 'seats', roomLabel: 'room', roomsLabel: 'rooms' },
  OTHER: { rooms: true, tables: true, tableLabel: 'table', tablesLabel: 'tables', roomLabel: 'room', roomsLabel: 'rooms' },
};
// Everyone else can group desks and set rules and rates per room (consulting rooms, meeting rooms),
// but has no use for tables and seat maps.
const ROOMS_ONLY: IndustryFeatures = { rooms: true, tables: false, tableLabel: 'table', tablesLabel: 'tables', roomLabel: 'room', roomsLabel: 'rooms' };

export function industryFeatures(industry?: string | null): IndustryFeatures {
  if (!industry) return FEATURES.OTHER;
  return FEATURES[industry] ?? ROOMS_ONLY;
}

export interface TermSource {
  industry?: string | null;
  customerLabel?: string | null;
  customerLabelPlural?: string | null;
}

export interface Terms {
  /** "patient" */
  person: string;
  /** "patients" */
  people: string;
  /** "Patient" */
  Person: string;
  /** "Patients" */
  People: string;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function pluralize(word: string): string {
  const w = word.trim();
  if (!w) return w;
  if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

export function defaultPersonFor(industry?: string | null): string {
  return INDUSTRIES.find((i) => i.id === industry)?.person ?? 'customer';
}

export function termsFor(org?: TermSource | null): Terms {
  const person = (org?.customerLabel || '').trim().toLowerCase() || defaultPersonFor(org?.industry);
  const people = (org?.customerLabelPlural || '').trim().toLowerCase() || pluralize(person);
  return { person, people, Person: cap(person), People: cap(people) };
}
