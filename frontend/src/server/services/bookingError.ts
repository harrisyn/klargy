/**
 * A refusal the customer or staff member can act on ("that slot is full"), with
 * the HTTP status to answer with. Lives in its own module so the services that
 * throw it can import it without importing each other.
 */
export class BookingError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}
