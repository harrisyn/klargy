import { clockTime, validTimeZone, weekdayIn } from '../utils/date';

/**
 * Rooms: their rules (who may book, party size, hours) and their rates (what
 * they cost, and the payment terms). Pure functions; the database parts live
 * in tables.service and bookingPayments.service.
 */

export interface RoomRules {
  id: string;
  name: string;
  isActive: boolean;
  onlineBookable: boolean;
  minPartySize: number | null;
  maxPartySize: number | null;
  openTime: string | null;
  closeTime: string | null;
  activeDays: string | null;
  allowCombine: boolean;
}

export interface RoomRates {
  priceMode: string;
  price: unknown;
  priceBasis: string;
  paymentMode: string | null;
  depositPercent: number | null;
  refundCutoffHours: number | null;
  refundTiers: unknown;
}

export type Room = RoomRules & RoomRates;

/** Why a room can't take this booking, or null when it can. */
export function roomRefusal(room: RoomRules, input: { start: Date; partySize: number; online: boolean; timeZone?: string | null }): string | null {
  if (!room.isActive) return `${room.name} isn’t open for bookings.`;
  if (input.online && !room.onlineBookable) return `${room.name} can’t be booked online. Please contact the venue.`;
  if (room.minPartySize && input.partySize < room.minPartySize) return `${room.name} is for ${room.minPartySize} or more people.`;
  if (room.maxPartySize && input.partySize > room.maxPartySize) return `${room.name} takes up to ${room.maxPartySize} people.`;
  const tz = validTimeZone(input.timeZone);
  if (room.activeDays) {
    const days = room.activeDays.split(',').map(Number);
    if (!days.includes(weekdayIn(input.start, tz))) return `${room.name} isn’t open that day.`;
  }
  if (room.openTime && room.closeTime) {
    const t = clockTime(input.start, tz);
    // Overnight hours (22:00 to 02:00) wrap past midnight.
    const open = room.openTime <= room.closeTime ? t >= room.openTime && t < room.closeTime : t >= room.openTime || t < room.closeTime;
    if (!open) return `${room.name} takes bookings from ${room.openTime} to ${room.closeTime}.`;
  }
  return null;
}

export interface RefundTier {
  hours: number;
  percent: number;
}

/** Tiers from JSON: positive hours, 0 to 100 percent, longest notice first. Anything malformed is dropped. */
export function parseRefundTiers(value: unknown): RefundTier[] {
  if (!Array.isArray(value)) return [];
  return (value as Record<string, unknown>[])
    .map((t) => ({ hours: Number(t?.hours), percent: Number(t?.percent) }))
    .filter((t) => Number.isFinite(t.hours) && t.hours >= 0 && Number.isFinite(t.percent) && t.percent >= 0 && t.percent <= 100)
    .sort((a, b) => b.hours - a.hours);
}

export interface PaymentTerms {
  paymentMode: string;
  depositPercent: number;
  refundCutoffHours: number;
  refundTiers: RefundTier[];
}

interface ServiceTerms {
  paymentMode: string;
  depositPercent: number;
  refundCutoffHours: number;
  refundTiers?: unknown;
}

/** The payment terms for a booking: the room's where it sets them, else the service's. */
export function paymentTerms(service: ServiceTerms, room?: RoomRates | null): PaymentTerms {
  const roomTiers = parseRefundTiers(room?.refundTiers);
  return {
    paymentMode: room?.paymentMode ?? service.paymentMode,
    depositPercent: room?.depositPercent ?? service.depositPercent,
    refundCutoffHours: room?.refundCutoffHours ?? service.refundCutoffHours,
    refundTiers: roomTiers.length ? roomTiers : parseRefundTiers(service.refundTiers),
  };
}

/**
 * The share of what was paid that comes back when cancelling with `hoursLeft`
 * to go: the first tier whose notice is met, else (no tiers) all of it up to
 * the cutoff and nothing after.
 */
export function refundPercent(terms: Pick<PaymentTerms, 'refundCutoffHours' | 'refundTiers'>, hoursLeft: number): number {
  if (terms.refundTiers.length) return terms.refundTiers.find((t) => hoursLeft >= t.hours)?.percent ?? 0;
  return hoursLeft >= terms.refundCutoffHours ? 100 : 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PriceParts {
  total: number;
  dueNow: number;
  /** What the room added (or, replacing the service price, the room's own price). */
  roomAmount: number;
}

/**
 * What a booking costs. A session's own price beats the service's; a room can
 * replace that (OVERRIDE) or add to it (SURCHARGE), per booking or per person.
 */
export function quoteBooking(input: {
  service: { price: unknown; priceBasis: string };
  slotPrice?: unknown;
  room?: RoomRates | null;
  partySize: number;
  terms: Pick<PaymentTerms, 'paymentMode' | 'depositPercent'>;
}): PriceParts {
  const party = Math.max(1, input.partySize);
  const unit = Number(input.slotPrice ?? input.service.price ?? 0) || 0;
  let total = unit > 0 ? (input.service.priceBasis === 'PERSON' ? unit * party : unit) : 0;
  let roomAmount = 0;
  const room = input.room;
  const roomPrice = room?.price == null ? NaN : Number(room.price);
  if (room && Number.isFinite(roomPrice) && roomPrice >= 0) {
    const amount = room.priceBasis === 'PERSON' ? roomPrice * party : roomPrice;
    if (room.priceMode === 'OVERRIDE') {
      // The room's price replaces the service's, but a session's own price still wins.
      if (input.slotPrice == null) total = amount;
      roomAmount = amount;
    } else if (room.priceMode === 'SURCHARGE') {
      total += amount;
      roomAmount = amount;
    }
  }
  total = round2(total);
  if (!(total > 0)) return { total: 0, dueNow: 0, roomAmount: 0 };
  let dueNow = 0;
  if (input.terms.paymentMode === 'FULL') dueNow = total;
  else if (input.terms.paymentMode === 'DEPOSIT') dueNow = round2((total * Math.min(100, Math.max(1, input.terms.depositPercent))) / 100);
  return { total, dueNow, roomAmount: round2(roomAmount) };
}

export interface PriceChange {
  from: number;
  to: number;
  /** What the customer has paid so far. */
  paid: number;
  /** to - from: positive means they owe more. */
  diff: number;
  /** Paid more than the new price: this much goes back. */
  refund: number;
  /** Paid less than the new price: this much is still owed. */
  balance: number;
}

/** How a booking's price moves when it changes room. Null when there is nothing to settle. */
export function priceChange(from: number, to: number, paid: number): PriceChange | null {
  const diff = round2(to - from);
  const refund = round2(Math.max(0, paid - to));
  // An overpaid booking still has something to settle even when the price itself hasn't moved.
  if (diff === 0 && refund === 0) return null;
  return { from, to, paid, diff, refund, balance: round2(Math.max(0, to - paid)) };
}

/** A one-line description of a room's rate for the booking page ("+10 per person"). */
export function rateNote(room: RoomRates): { mode: string; price: number | null; basis: string } {
  const price = room.price == null ? null : Number(room.price);
  return { mode: room.priceMode, price: room.priceMode === 'INHERIT' ? null : price, basis: room.priceBasis };
}
