// User types
export type UserRole = 'SUPER_ADMIN' | 'ORG_ADMIN' | 'LOCATION_ADMIN' | 'SERVICE_STAFF' | 'RECEPTIONIST' | 'PATIENT';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: UserRole;
  organizationId?: string;
  isActive: boolean;
  organization?: { id: string; name: string; industry?: string | null; customerLabel?: string | null; customerLabelPlural?: string | null; currency?: string } | null;
}

export interface AuthResponse {
  token: string;
  user: User;
}

// Organization types
export interface Organization {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  locations?: Location[];
  industry?: string | null;
  customerLabel?: string | null;
  customerLabelPlural?: string | null;
  /** Currency for the organization's plan, wallet and booking prices. */
  currency?: string;
}

export interface Location {
  id: string;
  organizationId: string;
  name: string;
  address?: string;
  timezone: string;
  externalReference?: string;
  publicCode?: string;
  /** First point of contact: kiosk and QR joins with no service chosen go here. */
  defaultServiceId?: string | null;
  services?: Service[];
}

// Service Point types
export type ServicePointType = 'RECEPTION' | 'TRIAGE' | 'CONSULTATION' | 'CASHIER' | 'PHARMACY' | 'LAB' | 'IMAGING' | 'OTHER';

export interface ServicePoint {
  id: string;
  organizationId: string;
  name: string;
  displayName?: string;
  type: ServicePointType;
  isActive: boolean;
  capacity: number;
  usedInServicesCount?: number;
  currentlyServing?: {
    ticketNumber: string;
    customerName: string;
    serviceName: string;
  };
}

// Service types
export type ServiceType = 'INDIVIDUAL' | 'GENERAL';

export interface Service {
  id: string;
  locationId: string;
  name: string;
  description?: string;
  type: ServiceType;
  slotDuration: number;
  concurrentLimit: number;
  activeDays: string;
  startTime: string;
  endTime: string;
  isActive: boolean;
  requiresName?: boolean;
  requiresPhone?: boolean;
  allowAnonymous?: boolean;
  /** Payment gate: joiners wait "awaiting payment" until cleared. */
  requiresClearance?: boolean;
  /** Public page: join the line now, book a time, or both. */
  bookingMode?: 'WALK_IN' | 'APPOINTMENT' | 'BOTH';
  bookingUnit?: 'BOOKING' | 'PERSON';
  minPartySize?: number;
  maxPartySize?: number;
  recurringSlots?: boolean;
  price?: string | number | null;
  priceBasis?: 'BOOKING' | 'PERSON';
  paymentMode?: 'NONE' | 'DEPOSIT' | 'FULL';
  depositPercent?: number;
  refundCutoffHours?: number;
  refundTiers?: { hours: number; percent: number }[] | null;
  tableMode?: 'NONE' | 'AUTO';
  roomId?: string | null;
  displayMode?: string;
  location?: Location;
  practitioners?: Practitioner[];
  queues?: Queue[];
}

export interface Practitioner {
  id: string;
  userId: string;
  serviceId: string;
  user?: User;
  service?: Service;
}

// Queue types
export type QueueStatus = 'ACTIVE' | 'PAUSED' | 'CLOSED';
export type EntryStatus = 'WAITING' | 'SERVING' | 'SERVED' | 'CANCELLED' | 'NO_SHOW';

export interface Queue {
  id: string;
  serviceId: string;
  date: string;
  status: QueueStatus;
  service?: Service;
  slots?: Slot[];
  entries?: QueueEntry[];
  stats?: {
    waiting: number;
    serving: number;
    served: number;
    total: number;
  };
}

export interface Slot {
  id: string;
  queueId: string;
  startTime: string;
  endTime: string;
  capacity: number;
  bookedCount: number;
  available?: number;
}

export interface QueueEntry {
  id: string;
  queueId: string;
  userId: string;
  ticketNumber: string;
  status: EntryStatus;
  priority: number;
  sortOrder: number;
  servicePointId?: string;
  sessionId?: string;
  joinedAt: string;
  calledAt?: string;
  servedAt?: string;
  completedAt?: string;
  notes?: string;
  user?: User;
  servicePoint?: ServicePoint;
  position?: number;
}

// Service Flow types
export interface ServiceFlow {
  id: string;
  fromServiceId: string;
  toServiceId: string;
  priority: number;
  displayName?: string;
  condition?: string;
  autoTransfer: boolean;
  isRequired: boolean;
  fromService?: Service;
  toService?: Service;
}

// Appointment types
export interface Appointment {
  id: string;
  userId: string;
  serviceId: string;
  slotId: string;
  createdBy: string;
  status: string;
  rescheduledAt?: string;
  notes?: string;
  user?: User;
  service?: Service;
  slot?: Slot;
}

// Notification types
export type NotificationType = 'QUEUE_JOINED' | 'TURN_APPROACHING' | 'NOW_SERVING' | 'APPOINTMENT_REMINDER' | 'APPOINTMENT_CANCELLED';
export type NotificationChannel = 'EMAIL' | 'SMS' | 'PUSH' | 'IN_APP';

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  channel: NotificationChannel;
  message: string;
  sentAt: string;
  readAt?: string;
}

// Analytics types
export interface QueueMetrics {
  queueId: string;
  serviceName: string;
  date: string;
  totalEntries: number;
  served: number;
  noShows: number;
  cancelled: number;
  waiting: number;
  serving: number;
  averageWaitTime: number;
  averageServiceTime: number;
  noShowRate: string;
}

// WebSocket events
export interface SocketEvents {
  'queue.updated': { queueId: string; action: string; entry?: QueueEntry };
  'entry.status_changed': { queueId: string; entryId: string; status: EntryStatus; entry?: QueueEntry };
  'slot.released': { slotId: string };
  'serviceflow.transition': { fromQueueId: string; toQueueId: string; entry: QueueEntry };
  'notification.sent': Notification;
}

/** A connected EMR's answer to a patient lookup (Klargy Connect phase 4,
 * docs/connect/v1.md section 7). The EMR runs the cover check. */
export interface PatientLookup {
  matched: boolean;
  patient: {
    ref?: string;
    displayName?: string;
    firstName?: string;
    mrNumber?: string | null;
    birthDate?: string | null;
    gender?: string | null;
    phoneMasked?: string | null;
    photoUrl?: string | null;
    identifiers?: Record<string, string | null>;
    cover?: {
      payer: string;
      plan: string | null;
      memberNumber: string | null;
      status: 'active' | 'expired' | 'inactive' | 'unknown';
      expiresOn: string | null;
      checkedVia: 'payer' | 'records' | null;
      message: string | null;
    } | null;
    flags?: string[];
  } | null;
  candidates: { ref: string; displayName: string; mrNumber: string | null; birthDate: string | null; phoneMasked: string | null }[];
}
