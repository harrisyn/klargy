import { describe, it, expect } from 'vitest';
import { paymentTerms, parseRefundTiers, priceChange, quoteBooking, refundPercent, roomRefusal, type Room } from './rooms.service';

// Rooms: their rules (who may book, party size, hours) and their rates and payment terms.

const room = (over: Partial<Room> = {}): Room => ({
  id: 'r1', name: 'Terrace', isActive: true, onlineBookable: true, minPartySize: null, maxPartySize: null, openTime: null, closeTime: null, activeDays: null,
  allowCombine: true, priceMode: 'INHERIT', price: null, priceBasis: 'BOOKING', paymentMode: null, depositPercent: null, refundCutoffHours: null, refundTiers: null, ...over,
});

// 2026-10-23 is a Friday (5). 19:30 UTC.
const friday1930 = new Date('2026-10-23T19:30:00Z');

describe('room rules', () => {
  const ask = (r: Room, over: object = {}) => roomRefusal(r, { start: friday1930, partySize: 2, online: true, timeZone: 'UTC', ...over });

  it('lets an ordinary booking in', () => {
    expect(ask(room())).toBeNull();
  });
  it('keeps staff-only rooms off the public page but not the front desk', () => {
    expect(ask(room({ onlineBookable: false }))).toMatch(/can’t be booked online/);
    expect(ask(room({ onlineBookable: false }), { online: false })).toBeNull();
  });
  it('enforces party limits', () => {
    expect(ask(room({ minPartySize: 6 }))).toMatch(/6 or more/);
    expect(ask(room({ maxPartySize: 1 }))).toMatch(/up to 1/);
    expect(ask(room({ minPartySize: 2, maxPartySize: 8 }))).toBeNull();
  });
  it('enforces days and hours in the location’s time zone', () => {
    expect(ask(room({ activeDays: '1,2,3' }))).toMatch(/isn’t open that day/);
    expect(ask(room({ activeDays: '5', openTime: '18:00', closeTime: '23:00' }))).toBeNull();
    expect(ask(room({ openTime: '12:00', closeTime: '15:00' }))).toMatch(/12:00 to 15:00/);
    // 19:30 UTC is 15:30 in New York: after a 15:00 close there.
    expect(ask(room({ openTime: '12:00', closeTime: '15:00' }), { timeZone: 'America/New_York' })).toMatch(/12:00 to 15:00/);
    expect(ask(room({ openTime: '12:00', closeTime: '16:00' }), { timeZone: 'America/New_York' })).toBeNull();
  });
  it('understands hours that run past midnight', () => {
    expect(ask(room({ openTime: '19:00', closeTime: '02:00' }))).toBeNull();
    expect(ask(room({ openTime: '19:00', closeTime: '02:00' }), { start: new Date('2026-10-23T01:00:00Z') })).toBeNull();
    expect(ask(room({ openTime: '19:00', closeTime: '02:00' }), { start: new Date('2026-10-23T10:00:00Z') })).toMatch(/19:00 to 02:00/);
  });
  it('refuses a closed room', () => {
    expect(ask(room({ isActive: false }))).toMatch(/isn’t open for bookings/);
  });
});

describe('rates', () => {
  const service = { price: 20, priceBasis: 'PERSON' };
  const terms = { paymentMode: 'FULL', depositPercent: 30 };
  const quote = (over: object = {}) => quoteBooking({ service, partySize: 4, terms, ...over });

  it('is the service’s price in a room with no rate', () => {
    expect(quote({ room: room() })).toEqual({ total: 80, dueNow: 80, roomAmount: 0 });
    expect(quote()).toEqual({ total: 80, dueNow: 80, roomAmount: 0 });
  });
  it('adds a surcharge per booking or per person', () => {
    expect(quote({ room: room({ priceMode: 'SURCHARGE', price: 25 }) })).toMatchObject({ total: 105, roomAmount: 25 });
    expect(quote({ room: room({ priceMode: 'SURCHARGE', price: 5, priceBasis: 'PERSON' }) })).toMatchObject({ total: 100, roomAmount: 20 });
  });
  it('lets a room’s own price replace the service’s', () => {
    expect(quote({ room: room({ priceMode: 'OVERRIDE', price: 40, priceBasis: 'BOOKING' }) })).toMatchObject({ total: 40, roomAmount: 40 });
    expect(quote({ room: room({ priceMode: 'OVERRIDE', price: 30, priceBasis: 'PERSON' }) })).toMatchObject({ total: 120 });
  });
  it('lets a session’s own price beat an override but still take a surcharge', () => {
    expect(quote({ slotPrice: 50, room: room({ priceMode: 'OVERRIDE', price: 10 }) })).toMatchObject({ total: 200 }); // 50 per person x 4
    expect(quote({ slotPrice: 50, room: room({ priceMode: 'SURCHARGE', price: 10 }) })).toMatchObject({ total: 210 });
  });
  it('prices a free service with a room charge', () => {
    expect(quoteBooking({ service: { price: null, priceBasis: 'BOOKING' }, partySize: 2, terms, room: room({ priceMode: 'SURCHARGE', price: 15 }) })).toMatchObject({ total: 15, dueNow: 15 });
  });
  it('takes a deposit or nothing up front', () => {
    expect(quote({ terms: { paymentMode: 'DEPOSIT', depositPercent: 25 } }).dueNow).toBe(20);
    expect(quote({ terms: { paymentMode: 'NONE', depositPercent: 25 } })).toMatchObject({ total: 80, dueNow: 0 });
  });
});

describe('payment and refund terms', () => {
  const service = { paymentMode: 'NONE', depositPercent: 30, refundCutoffHours: 24, refundTiers: [{ hours: 48, percent: 100 }] };

  it('uses the room’s terms where it sets them, else the service’s', () => {
    expect(paymentTerms(service, null)).toMatchObject({ paymentMode: 'NONE', depositPercent: 30, refundCutoffHours: 24 });
    expect(paymentTerms(service, room({ paymentMode: 'DEPOSIT', depositPercent: 50, refundCutoffHours: 72 }))).toMatchObject({ paymentMode: 'DEPOSIT', depositPercent: 50, refundCutoffHours: 72 });
    expect(paymentTerms(service, room({ refundTiers: [{ hours: 96, percent: 100 }, { hours: 24, percent: 50 }] })).refundTiers).toEqual([{ hours: 96, percent: 100 }, { hours: 24, percent: 50 }]);
    expect(paymentTerms(service, room()).refundTiers).toEqual([{ hours: 48, percent: 100 }]);
  });

  it('refunds by notice: the first tier met, longest notice first', () => {
    const terms = { refundCutoffHours: 24, refundTiers: parseRefundTiers([{ hours: 24, percent: 50 }, { hours: 72, percent: 100 }, { hours: 6, percent: 25 }]) };
    expect(refundPercent(terms, 100)).toBe(100);
    expect(refundPercent(terms, 72)).toBe(100);
    expect(refundPercent(terms, 30)).toBe(50);
    expect(refundPercent(terms, 8)).toBe(25);
    expect(refundPercent(terms, 2)).toBe(0);
  });

  it('without tiers it is all or nothing at the cutoff', () => {
    const terms = { refundCutoffHours: 24, refundTiers: [] };
    expect(refundPercent(terms, 24)).toBe(100);
    expect(refundPercent(terms, 23.9)).toBe(0);
  });

  it('drops malformed tiers', () => {
    expect(parseRefundTiers([{ hours: -1, percent: 50 }, { hours: 10, percent: 150 }, { hours: 'x', percent: 5 }, null, { hours: 12, percent: 40 }])).toEqual([{ hours: 12, percent: 40 }]);
    expect(parseRefundTiers('nope')).toEqual([]);
  });
});

describe('priceChange', () => {
  it('is null when nothing changes', () => expect(priceChange(50, 50, 50)).toBeNull());
  it('still settles an overpayment when the price itself has not moved', () => expect(priceChange(50, 50, 80)).toMatchObject({ diff: 0, refund: 30 }));
  it('refunds the overpayment when the new room costs less', () => {
    expect(priceChange(80, 50, 80)).toEqual({ from: 80, to: 50, paid: 80, diff: -30, refund: 30, balance: 0 });
  });
  it('owes the difference when it costs more', () => {
    expect(priceChange(50, 80, 50)).toEqual({ from: 50, to: 80, paid: 50, diff: 30, refund: 0, balance: 30 });
  });
  it('refunds nothing when only a deposit was paid and it is still covered', () => {
    expect(priceChange(100, 70, 30)).toMatchObject({ refund: 0, balance: 40 });
  });
});
