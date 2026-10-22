import axios, { AxiosInstance, AxiosError } from 'axios';
import type { PatientLookup, Service, User } from '@/types';

import { API_BASE as API_BASE_URL } from '@/lib/apiBase';

export interface DisplayConfig {
  ticker: { enabled: boolean; messages: string[]; speed: 'slow' | 'normal' | 'fast' };
  media: { enabled: boolean; mode: 'interstitial' | 'split'; everySeconds: number };
  callFlash: boolean;
}

export interface DisplayPlaylist {
  id: string;
  name: string;
  locationId: string | null;
  days: string;
  startTime: string | null;
  endTime: string | null;
  priority: number;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  items: { mediaId: string; sortOrder: number }[];
}

export interface DisplayEntitlement {
  status: 'pack' | 'included' | 'trial' | 'trial_available' | 'trial_ended';
  allowed: boolean;
  maxItems: number;
  maxUploadBytes: number;
  streaming: boolean;
  packs: number;
  trialDays: number;
  trialEndsAt: string | null;
  itemsUsed: number;
}

export interface DisplayMediaItem {
  id: string;
  kind: 'IMAGE' | 'VIDEO' | 'STREAM';
  url: string;
  title: string;
  durationSeconds: number;
  locationId?: string | null;
  isActive?: boolean;
  sortOrder?: number;
  startsAt?: string | null;
  endsAt?: string | null;
}

export interface AvailableSlot {
  id: string;
  startTime: string;
  endTime: string;
  available: number;
  capacity: number;
}

export interface PatientSummary {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
}

export interface Appointment {
  id: string;
  status: 'PENDING_PAYMENT' | 'SCHEDULED' | 'CONFIRMED' | 'CHECKED_IN' | 'CANCELLED' | 'NO_SHOW' | 'COMPLETED';
  notes: string | null;
  /** People in the booking. */
  partySize?: number;
  /** The tables or seats it holds, and the room it is in. */
  tables?: { table: { id: string; name: string; seats: number; area: string | null } }[];
  room?: { id: string; name: string } | null;
  amount?: string | number | null;
  amountPaid?: string | number | null;
  currency?: string | null;
  paymentStatus?: 'NONE' | 'PENDING' | 'PAID' | 'PARTIAL_REFUND' | 'REFUNDED' | 'EXPIRED' | 'FAILED';
  /** STAFF (booked at the desk) or ONLINE (booked by the customer). */
  source?: 'STAFF' | 'ONLINE';
  rescheduledAt: string | null;
  serviceId: string;
  startTime: string;
  endTime: string | null;
  user: { id: string; firstName: string; lastName: string; email: string; phone: string | null };
  service: { id: string; name: string; location: { id: string; name: string } };
  /** Null for an appointment booked in a connected EMR. */
  slot: { id: string; startTime: string; endTime: string } | null;
}

/** Booked patients arriving on time are placed by their booked time. */
export interface BookedArrivalSettings {
  enabled: boolean;
  earlyMinutes: number;
  lateMinutes: number;
  /** Percent: at most this share of those placed ahead of a walk-in are booked patients who arrived after them. */
  maxBookedShare: number;
}

export interface NotificationSettings {
  turnApproachingAt: number;
  email: boolean;
  sms: boolean;
}

export interface WhatsAppTemplateMappingInfo {
  name: string;
  language: string;
  status?: string;
  variables: string[];
  contentSid?: string;
  category?: string;
}

export interface WhatsAppSettingsInfo {
  configured: boolean;
  webhookUrl: string;
  /** The platform offers a shared WhatsApp number. */
  platformAvailable?: boolean;
  provider?: string;
  isEnabled?: boolean;
  settings?: Record<string, string>;
  secretsMasked?: Record<string, string | null>;
  verifyToken?: string | null;
  webhookSecret?: string | null;
  templates?: Record<string, WhatsAppTemplateMappingInfo>;
  fallbackToSms?: boolean;
  consentMode?: 'EXPLICIT' | 'IMPLIED';
  defaultCountryCode?: string | null;
  lastTestedAt?: string | null;
  lastTestOk?: boolean | null;
  lastTestMessage?: string | null;
  contacts?: { optedIn: number; optedOut: number };
}

export interface WhatsAppProviderTemplate {
  name: string;
  language: string;
  status: string;
  category?: string;
  body?: string;
  paramCount: number;
  contentSid?: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  isActive: boolean;
  createdAt: string;
  lastDelivery?: { status: string; responseCode: number | null; createdAt: string } | null;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  responseCode: number | null;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt: string | null;
}

export interface EmrIntegration {
  id: string;
  name: string;
  kind: string;
  status: 'ACTIVE' | 'REVOKED';
  keyPrefix: string;
  systemName: string | null;
  systemVersion: string | null;
  registered: boolean;
  embedOrigins: string[];
  catalogPublishedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export type EmrMappableType = 'location' | 'service' | 'service_point' | 'staff';

export interface EmrExternalRecord { id: string; name: string; email?: string | null; locationId?: string | null; kind?: string | null }

export interface EmrIntegrationDetail extends EmrIntegration {
  externalCatalog: {
    locations: EmrExternalRecord[];
    services: EmrExternalRecord[];
    servicePoints: EmrExternalRecord[];
    practitioners: EmrExternalRecord[];
  } | null;
  klargy: {
    locations: { id: string; name: string; externalId: string | null }[];
    services: { id: string; name: string; locationId: string; externalId: string | null }[];
    servicePoints: { id: string; name: string; type: string; externalId: string | null }[];
    staff: { id: string; name: string; email: string; externalId: string | null }[];
  };
}

export interface AuditLogEntry {
  id: string;
  action: string;
  createdAt: string;
  data: Record<string, unknown> | null;
  actor: { id: string; firstName: string; lastName: string; role: string } | null;
  entry: { ticketNumber: string; serviceName: string } | null;
}

export interface AiStatus {
  planIncludesAi: boolean;
  enabled: boolean;
  providerConfigured: boolean;
  provider: string | null;
}

export interface AiInsight {
  id: string;
  kind: 'ASK' | 'DIGEST';
  question: string | null;
  answer: string;
  sources: { tool: string; input: Record<string, unknown>; output: unknown }[] | null;
  model: string | null;
  createdAt: string;
}

export interface WaitAlert {
  serviceId: string;
  service: string;
  severity: 'warning' | 'critical' | 'info';
  message: string;
}

export interface AiProviderConfig {
  provider: 'anthropic' | 'openai' | 'azure_openai' | 'gemini' | 'openai_compatible';
  configured: boolean;
  isActive: boolean;
  model: string | null;
  defaultModel: string | null;
  baseUrl: string | null;
  apiKeyMasked: string | null;
  updatedAt: string | null;
}

export interface CustomDomainInfo {
  domain: string;
  status: 'PENDING' | 'VERIFIED';
  verifiedAt: string | null;
  createdAt: string;
  cnameTarget: string;
}

export interface WalletSummary {
  balance: number;
  currency: string;
  walletManaged: boolean;
  nextCharge: { amount: number; date: string } | null;
  override: { until: string; planName: string; endBehavior: string | null; customPrice: number | null } | null;
  entries: { id: string; amount: number; currency: string; kind: string; reason: string; createdAt: string }[];
}

export interface FlowTemplateInfo {
  id: string;
  name: string;
  description: string;
  industries: string[];
  services: { name: string; description: string; requiresClearance: boolean; bookingMode: 'WALK_IN' | 'APPOINTMENT' | 'BOTH'; slotDuration: number; partySize: { min: number; max: number } | null; tables: boolean }[];
  flows: Record<string, string[]>;
  defaultService: string;
  /** Rooms the template lays out, with their floor plans (only for kinds of business that use tables). */
  rooms: { name: string; description: string; layoutWidth: number; layoutHeight: number; tables: { name: string; seats: number; x: number; y: number; width: number; height: number; shape: 'RECT' | 'ROUND'; rotation: number }[] }[];
}

export interface CurrencySettings {
  base: string;
  rates: Record<string, number>;
  refreshedAt: string | null;
  autoRefresh: boolean;
  usage: Record<string, { organizations: number; plans: number }>;
  missingRates: string[];
}

export interface RoomRow {
  id: string;
  locationId: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  onlineBookable: boolean;
  allowCombine: boolean;
  minPartySize: number | null;
  maxPartySize: number | null;
  openTime: string | null;
  closeTime: string | null;
  activeDays: string | null;
  priceMode: 'INHERIT' | 'OVERRIDE' | 'SURCHARGE';
  price: number | null;
  priceBasis: 'BOOKING' | 'PERSON';
  paymentMode: 'NONE' | 'DEPOSIT' | 'FULL' | null;
  depositPercent: number | null;
  refundCutoffHours: number | null;
  refundTiers: { hours: number; percent: number }[] | null;
  layoutWidth: number;
  layoutHeight: number;
  layoutImageUrl: string | null;
}

export interface RoomTableRow {
  id: string;
  name: string;
  seats: number;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  rotation: number;
  shape: string;
  isActive: boolean;
}

export interface FloorMap {
  room: { id: string; name: string; layoutWidth: number; layoutHeight: number; layoutImageUrl: string | null };
  tables: (Omit<RoomTableRow, 'isActive'> & { status: 'free' | 'taken' | 'unavailable' })[];
  at?: string;
  bookings?: { tableId: string; appointmentId: string; startTime: string; endTime: string; partySize: number; status: string; name: string }[];
}

export interface PayoutBalance {
  currency: string;
  pending: number;
  available: number;
  inReview: number;
  paidOut: number;
}

export interface PaymentsOverview {
  currency: string;
  supportedCurrencies: string[];
  collectedBy: 'ORG' | 'PLATFORM' | 'NONE';
  collectorProvider: string | null;
  platformCollects: boolean;
  canUseOwnKeys: boolean;
  ownProviders: { provider: 'stripe' | 'paystack'; isActive: boolean; publicKey: string | null; secretKey: string; hasWebhookSecret: boolean; webhookUrl: string }[];
  webhookUrls: Record<string, string>;
  payoutDetails: string;
  payout: { holdDays: number; feePercent: number; minPayout: number; balance: PayoutBalance };
  requests: { id: string; amount: number; currency: string; status: 'REQUESTED' | 'PAID' | 'REJECTED'; note: string | null; requestedAt: string; reviewedAt: string | null }[];
  ledger: { id: string; amount: number; currency: string; kind: string; reason: string; availableAt: string; createdAt: string }[];
}

export interface PayoutRequestRow {
  id: string;
  organization: { id: string; name: string; slug: string | null };
  amount: number;
  currency: string;
  status: 'REQUESTED' | 'PAID' | 'REJECTED';
  details: string;
  note: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  orgBalance: PayoutBalance;
}

export interface ServiceSession {
  id: string;
  startTime: string;
  endTime: string;
  capacity: number;
  booked: number;
  label: string | null;
  price: number | null;
}

export interface PayoutBalance {
  currency: string;
  pending: number;
  available: number;
  inReview: number;
  paidOut: number;
}

export interface PaymentsOverview {
  currency: string;
  collectedBy: 'ORG' | 'PLATFORM' | 'NONE';
  collectorProvider: string | null;
  platformCollects: boolean;
  canUseOwnKeys: boolean;
  ownProviders: { provider: 'stripe' | 'paystack'; isActive: boolean; publicKey: string | null; secretKey: string; hasWebhookSecret: boolean; webhookUrl: string }[];
  webhookUrls: Record<string, string>;
  payoutDetails: string;
  payout: { holdDays: number; feePercent: number; minPayout: number; balance: PayoutBalance };
  requests: { id: string; amount: number; currency: string; status: 'REQUESTED' | 'PAID' | 'REJECTED'; note: string | null; requestedAt: string; reviewedAt: string | null }[];
  ledger: { id: string; amount: number; currency: string; kind: string; reason: string; availableAt: string; createdAt: string }[];
}

export interface PayoutRequestRow {
  id: string;
  organization: { id: string; name: string; slug: string | null };
  amount: number;
  currency: string;
  status: 'REQUESTED' | 'PAID' | 'REJECTED';
  details: string;
  note: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  orgBalance: PayoutBalance;
}

export interface ServiceSession {
  id: string;
  startTime: string;
  endTime: string;
  capacity: number;
  booked: number;
  label: string | null;
  price: number | null;
}

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Request interceptor - add auth token
    this.client.interceptors.request.use((config) => {
      if (typeof window !== 'undefined') {
        const token = localStorage.getItem('token');
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
      }
      return config;
    });

    // Response interceptor - handle errors
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        // A 401 from /auth/* is a failed sign-in, not an expired session -
        // let the form show the error instead of reloading the page.
        const isAuthRequest = error.config?.url?.startsWith('/auth/');
        if (error.response?.status === 401 && !isAuthRequest) {
          if (typeof window !== 'undefined') {
            localStorage.removeItem('token');
            window.location.href = '/login';
          }
        }
        return Promise.reject(error);
      }
    );
  }

  // Auth
  async login(email: string, password: string, options?: { slug?: string; adminLogin?: boolean }) {
    const { data } = await this.client.post('/auth/login', { email, password, ...options });
    return data;
  }

  // Klargy Connect desk launch: trade the EMR's one-time code for a session.
  async exchangeDeskLaunch(code: string): Promise<{
    token: string;
    user: User;
    launchId: string;
    origin: string;
    servicePointId: string | null;
  }> {
    const { data } = await this.client.post('/auth/desk-launch', { code });
    return data;
  }

  async getLaunchDesk(launchId: string, instanceId: string): Promise<{ servicePoint: { id: string; name: string; externalId: string | null } }> {
    const { data } = await this.client.get(`/desk-launches/${encodeURIComponent(launchId)}/desks/${encodeURIComponent(instanceId)}`);
    return data;
  }

  // Klargy Connect phase 4: the EMR's record for a patient (it runs the cover check).
  async connectLookup(params: { identifierType: string; identifier: string; locationId?: string }): Promise<PatientLookup> {
    const { data } = await this.client.post('/connect-lookup', params);
    return data;
  }

  async getEntryLookup(entryId: string): Promise<PatientLookup & { system: string }> {
    const { data } = await this.client.get(`/connect-lookup/entries/${encodeURIComponent(entryId)}`);
    return data;
  }

  async getLaunchEntry(launchId: string, entryId: string): Promise<{ entry: Record<string, unknown> }> {
    const { data } = await this.client.get(`/desk-launches/${encodeURIComponent(launchId)}/entries/${encodeURIComponent(entryId)}`);
    return data;
  }

  async register(userData: { email: string; password: string; firstName: string; lastName: string }) {
    const { data } = await this.client.post('/auth/register', userData);
    return data;
  }

  async previewInvite(code: string): Promise<{
    role: string;
    email?: string | null;
    status: 'valid' | 'used' | 'expired';
    organization: { name: string; slug: string | null; logoUrl: string | null };
  }> {
    const { data } = await this.client.get(`/public/invites/${encodeURIComponent(code)}`);
    return data;
  }

  async acceptInvite(payload: { inviteToken: string; email: string; password: string; firstName: string; lastName: string; phone?: string }): Promise<{ organizationSlug: string | null }> {
    const { data } = await this.client.post('/auth/register', payload);
    return data;
  }

  async getSetupStatus() {
    const { data } = await this.client.get<{ needsSetup: boolean }>('/public/setup/status');
    return data;
  }

  async completeSetup(body: { token: string; email: string; password: string; firstName: string; lastName: string }) {
    const { data } = await this.client.post<{ email: string }>('/public/setup', body);
    return data;
  }

  async forgotPassword(email: string) {
    const { data } = await this.client.post('/auth/forgot-password', { email });
    return data;
  }

  async resetPassword(token: string, password: string) {
    const { data } = await this.client.post('/auth/reset-password', { token, password });
    return data;
  }

  // Organizations
  async getOrganizations() {
    const { data } = await this.client.get('/orgs');
    return data;
  }

  async getOrganization(id: string) {
    const { data } = await this.client.get(`/orgs/${id}`);
    return data;
  }

  async createOrganization(org: { name: string; email?: string; phone?: string }) {
    const { data } = await this.client.post('/orgs', org);
    return data;
  }

  // Locations
  async getLocations(organizationId: string) {
    const { data } = await this.client.get(`/locations/orgs/${organizationId}/locations`);
    return data;
  }

  async getPublicLocations() {
    const { data } = await this.client.get('/public/locations');
    return data;
  }

  async getOrgBySlug(slug: string): Promise<{ id: string; name: string; slug: string; logoUrl: string | null; primaryColor: string | null; hidePoweredBy: boolean } | null> {
    try {
      const { data } = await this.client.get(`/public/orgs/by-slug/${encodeURIComponent(slug)}`);
      return data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async getOrgByDomain(domain: string): Promise<{ id: string; name: string; slug: string; logoUrl: string | null; primaryColor: string | null; hidePoweredBy: boolean } | null> {
    try {
      const { data } = await this.client.get(`/public/orgs/by-domain/${encodeURIComponent(domain)}`);
      return data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async getLocation(id: string) {
    const { data } = await this.client.get(`/locations/${id}`);
    return data;
  }

  async createLocation(organizationId: string, location: { name: string; address?: string; timezone?: string }) {
    const { data } = await this.client.post(`/locations/orgs/${organizationId}/locations`, location);
    return data;
  }

  async updateLocation(id: string, payload: { name?: string; address?: string; timezone?: string; publicCode?: string | null; externalReference?: string | null; defaultServiceId?: string | null }) {
    const { data } = await this.client.put(`/locations/${id}`, payload);
    return data;
  }

  // Services
  async getServices(locationId: string) {
    const { data } = await this.client.get(`/services/locations/${locationId}/services`);
    return data;
  }

  async getService(id: string) {
    const { data } = await this.client.get(`/services/${id}`);
    return data;
  }

  async createService(payload: Partial<Service> & {
    locationIds: string[];
    servicePoints?: { servicePointId: string; capacity: number }[];
  }) {
    const { data } = await this.client.post('/services', payload);
    return data as { services: Service[] };
  }

  // Queues
  async createQueue(serviceId: string, date?: string) {
    const { data } = await this.client.post('/queues', { serviceId, date });
    return data;
  }

  async getQueue(id: string) {
    const { data } = await this.client.get(`/queues/${id}`);
    return data;
  }

  async getServiceQueues(serviceId: string, date?: string) {
    const params = date ? `?date=${date}` : '';
    const { data } = await this.client.get(`/queues/service/${serviceId}${params}`);
    return data;
  }

  async joinQueue(queueId: string, userId: string, priority?: number) {
    const { data } = await this.client.post(`/queues/${queueId}/join`, { userId, priority });
    return data;
  }

  async callNext(queueId: string) {
    const { data } = await this.client.post(`/queues/${queueId}/call-next`);
    return data;
  }

  async markServed(queueId: string, entryId: string) {
    const { data } = await this.client.patch(`/queues/${queueId}/entry/${entryId}/serve`);
    return data;
  }

  async cancelEntry(queueId: string, entryId: string) {
    const { data } = await this.client.patch(`/queues/${queueId}/entry/${entryId}/cancel`);
    return data;
  }

  async getWaitTime(queueId: string) {
    const { data } = await this.client.get(`/queues/${queueId}/waittime`);
    return data;
  }

  async getTicket(queueId: string, entryId: string) {
    const { data } = await this.client.get(`/queues/${queueId}/ticket/${entryId}`);
    return data;
  }

  // Appointments
  async createAppointment(appointment: {
    serviceId: string;
    slotId: string;
    userId?: string;
    patient?: { firstName: string; lastName: string; phone?: string; email?: string };
    notes?: string;
  }): Promise<Appointment> {
    const { data } = await this.client.post('/appointments', appointment);
    return data;
  }

  async getAppointments(params?: { userId?: string; serviceId?: string; locationId?: string; date?: string; status?: string }): Promise<Appointment[]> {
    const { data } = await this.client.get('/appointments', { params });
    return data;
  }

  async rescheduleAppointment(id: string, newSlotId: string): Promise<Appointment> {
    const { data } = await this.client.patch(`/appointments/${id}/reschedule`, { newSlotId });
    return data;
  }

  async cancelAppointment(id: string): Promise<Appointment> {
    const { data } = await this.client.patch(`/appointments/${id}/cancel`);
    return data;
  }

  async searchPatients(q: string): Promise<PatientSummary[]> {
    const { data } = await this.client.get('/appointments/patients/search', { params: { q } });
    return data;
  }

  async getUserAppointments(userId: string, upcoming?: boolean) {
    const params = upcoming ? '?upcoming=true' : '';
    const { data } = await this.client.get(`/appointments/user/${userId}${params}`);
    return data;
  }

  async getAvailableSlots(serviceId: string, date?: string): Promise<{ slots: AvailableSlot[]; message?: string; queueId?: string }> {
    const { data } = await this.client.get(`/appointments/service/${serviceId}/slots`, { params: date ? { date } : undefined });
    return data;
  }

  async checkInAppointment(id: string) {
    const { data } = await this.client.post(`/appointments/${id}/check-in`);
    return data;
  }

  // Users
  async getMe() {
    const { data } = await this.client.get('/users/me');
    return data;
  }

  // Subscription
  async getMySubscription() {
    const { data } = await this.client.get('/subscription');
    return data;
  }

  async getPlans() {
    const { data } = await this.client.get('/plans', { params: { includeInactive: false } });
    return data;
  }

  async createSubscriptionCheckout(payload: { planId: string; provider: 'stripe' | 'paystack'; billingCycle: 'monthly' | 'quarterly' | 'yearly' }) {
    const { data } = await this.client.post('/tenant/subscription/checkout', payload);
    return data;
  }

  async switchToFreePlan(planId: string) {
    const { data } = await this.client.post(`/tenant/subscription/switch/${planId}`);
    return data as { success: boolean; planId: string; planName: string };
  }

  // Wallet
  async getMyWallet() {
    const { data } = await this.client.get('/tenant/wallet');
    return data as WalletSummary;
  }

  async payPlanFromWallet(payload: { planId: string; billingCycle: 'monthly' | 'quarterly' | 'yearly' }) {
    const { data } = await this.client.post('/tenant/wallet/checkout', payload);
    return data as WalletSummary & { planName: string; charged: number };
  }

  // Add-ons
  async getMyAddOns() {
    const { data } = await this.client.get('/tenant/addons');
    return data;
  }

  async createAddOnCheckout(payload: { resourceType: 'LOCATIONS' | 'USERS' | 'DISPLAY_MEDIA'; quantity: number; billingMode: 'recurring' | 'one_off'; provider: 'stripe' | 'paystack' }) {
    const { data } = await this.client.post('/tenant/addons/checkout', payload);
    return data;
  }

  async cancelAddOn(id: string) {
    const { data } = await this.client.delete(`/tenant/addons/${id}`);
    return data;
  }

  async getMyAddOnPricing() {
    const { data } = await this.client.get('/tenant/addon-pricing');
    return data;
  }

  async getAddOnPricing() {
    const { data } = await this.client.get('/superadmin/addon-pricing');
    return data;
  }

  async updateAddOnPricing(resourceType: 'LOCATIONS' | 'USERS' | 'DISPLAY_MEDIA', payload: { pricePerUnitMonthly: number; pricePerUnitOneOff: number; currency?: string }) {
    const { data } = await this.client.put(`/superadmin/addon-pricing/${resourceType}`, payload);
    return data;
  }

  // File Storage Providers (superadmin)
  async getPlatformWhatsApp(): Promise<{
    configured: boolean;
    isEnabled: boolean;
    provider: string | null;
    settings: Record<string, string>;
    secretsMasked: Record<string, string | null>;
    orgsUsing?: number;
  }> {
    const { data } = await this.client.get('/superadmin/platform-whatsapp');
    return data;
  }

  async savePlatformWhatsApp(payload: { provider: string; isEnabled: boolean; settings: Record<string, string>; secrets: Record<string, string> }) {
    const { data } = await this.client.put('/superadmin/platform-whatsapp', payload);
    return data;
  }

  async testPlatformWhatsApp(to?: string): Promise<{ ok: boolean; message?: string; error?: string }> {
    const { data } = await this.client.post('/superadmin/platform-whatsapp/test', { to });
    return data;
  }

  async getFileStorageProviders() {
    const { data } = await this.client.get('/superadmin/file-storage');
    return data;
  }

  async saveFileStorageProvider(provider: string, payload: { publicKey?: string; secretKey?: string; isActive: boolean; settings?: Record<string, unknown> }) {
    const { data } = await this.client.put(`/superadmin/file-storage/${provider}`, payload);
    return data;
  }

  async testFileStorageProvider(provider: string) {
    const { data } = await this.client.post(`/superadmin/file-storage/${provider}/test`);
    return data;
  }

  // Organization branding (tenant)
  async uploadOrganizationLogo(organizationId: string, file: File) {
    const form = new FormData();
    form.append('logo', file);
    const { data } = await this.client.post(`/orgs/${organizationId}/logo`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data as { id: string; logoUrl: string };
  }

  async getCustomDomain(organizationId: string) {
    const { data } = await this.client.get(`/orgs/${organizationId}/custom-domain`);
    return data as CustomDomainInfo | null;
  }

  async setCustomDomain(organizationId: string, domain: string) {
    const { data } = await this.client.put(`/orgs/${organizationId}/custom-domain`, { domain });
    return data as CustomDomainInfo;
  }

  async verifyCustomDomain(organizationId: string) {
    const { data } = await this.client.post(`/orgs/${organizationId}/custom-domain/verify`);
    return data as CustomDomainInfo;
  }

  async deleteCustomDomain(organizationId: string) {
    await this.client.delete(`/orgs/${organizationId}/custom-domain`);
  }

  async getWhatsApp(organizationId: string) {
    const { data } = await this.client.get(`/orgs/${organizationId}/whatsapp`);
    return data as WhatsAppSettingsInfo;
  }

  async saveWhatsApp(
    organizationId: string,
    body: {
      provider: string;
      isEnabled: boolean;
      settings: Record<string, string>;
      secrets: Record<string, string>;
      templates: Record<string, WhatsAppTemplateMappingInfo>;
      fallbackToSms: boolean;
      consentMode: 'EXPLICIT' | 'IMPLIED';
      defaultCountryCode: string;
    }
  ) {
    const { data } = await this.client.put(`/orgs/${organizationId}/whatsapp`, body);
    return data as WhatsAppSettingsInfo;
  }

  async deleteWhatsApp(organizationId: string) {
    const { data } = await this.client.delete(`/orgs/${organizationId}/whatsapp`);
    return data as WhatsAppSettingsInfo;
  }

  async testWhatsApp(organizationId: string) {
    const { data } = await this.client.post(`/orgs/${organizationId}/whatsapp/test`);
    return data as { ok: boolean; message: string };
  }

  async sendWhatsAppTest(organizationId: string, to: string) {
    const { data } = await this.client.post(`/orgs/${organizationId}/whatsapp/send-test`, { to });
    return data as { ok: true; via: 'text' | 'template'; messageId: string | null };
  }

  async syncWhatsAppTemplates(organizationId: string) {
    const { data } = await this.client.post(`/orgs/${organizationId}/whatsapp/templates/sync`);
    return data as { available: WhatsAppProviderTemplate[]; templates: Record<string, WhatsAppTemplateMappingInfo> };
  }

  async getUsers(params?: { organizationId?: string; role?: string }) {
    const { data } = await this.client.get('/users', { params });
    return data;
  }

  async getUser(id: string) {
    const { data } = await this.client.get(`/users/${id}`);
    return data;
  }

  async updateUserIdentity(userId: string, identityData: Record<string, unknown>) {
    const { data } = await this.client.put(`/users/${userId}/identity`, { identityData });
    return data;
  }

  /** `userId` (connected-system sources): look them up by the EMR's own id when Klargy has it. */
  async fetchFromDataSource(sourceId: string, params: { identifier?: string; identifierType?: string; userId?: string; locationId?: string }) {
    const { data } = await this.client.post(`/data-sources/${sourceId}/fetch`, params);
    return data;
  }

  // Notifications
  async getNotifications(userId: string, unreadOnly?: boolean) {
    const params = unreadOnly ? '?unreadOnly=true' : '';
    const { data } = await this.client.get(`/notifications/user/${userId}${params}`);
    return data;
  }

  async markNotificationRead(id: string) {
    const { data } = await this.client.patch(`/notifications/${id}/read`);
    return data;
  }

  // Analytics
  async getQueueMetrics(queueId: string) {
    const { data } = await this.client.get(`/analytics/queue/${queueId}`);
    return data;
  }

  async getServiceMetrics(serviceId: string, startDate?: string, endDate?: string) {
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    const { data } = await this.client.get(`/analytics/service/${serviceId}?${params}`);
    return data;
  }

  async getLocationMetrics(locationId: string, date?: string) {
    const params = date ? `?date=${date}` : '';
    const { data } = await this.client.get(`/analytics/location/${locationId}${params}`);
    return data;
  }

  // Enhanced analytics
  async getDetailedAnalytics(locationId: string, startDate?: string, endDate?: string) {
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    const queryString = params.toString();
    const { data } = await this.client.get(`/analytics/location/${locationId}/detailed${queryString ? `?${queryString}` : ''}`);
    return data;
  }

  async getJourneyAnalytics(locationId: string, startDate?: string, endDate?: string) {
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    const queryString = params.toString();
    const { data } = await this.client.get(`/analytics/location/${locationId}/journeys${queryString ? `?${queryString}` : ''}`);
    return data;
  }

  async getPeakHoursAnalysis(serviceId: string, days?: number) {
    const params = days ? `?days=${days}` : '';
    const { data } = await this.client.get(`/analytics/service/${serviceId}/peak-hours${params}`);
    return data;
  }

  // Invites (admin)
  async createInvite(payload: { role?: string; organizationId?: string; expiresAt?: string; email?: string }) {
    const { data } = await this.client.post('/invites', payload);
    return data as { invite: { id: string; code: string; role: string; email?: string | null; used: boolean; expiresAt: string | null; createdAt: string }; emailed?: boolean };
  }

  async revokeInvite(id: string) {
    await this.client.delete(`/invites/${id}`);
  }

  async updateUser(id: string, patch: { role?: string; isActive?: boolean; firstName?: string; lastName?: string; phone?: string }) {
    const { data } = await this.client.put(`/users/${id}`, patch);
    return data;
  }

  async getInvites() {
    const { data } = await this.client.get('/invites');
    return data;
  }

  // Public endpoints (no auth required)
  async getLocationByCode(code: string) {
    const { data } = await this.client.get(`/public/locations/${code}`);
    return data;
  }

  async publicJoinQueue(payload: { serviceId: string; name: string; phone?: string; notes?: string }) {
    const { data } = await this.client.post('/public/join', payload);
    return data;
  }

  async getPublicStatus(queueId: string, entryId: string) {
    const { data } = await this.client.get(`/public/status/${queueId}/${entryId}`);
    return data;
  }

  // Session-based public join (for returning users)
  async publicJoinQueueWithSession(payload: { 
    serviceId: string; 
    name: string; 
    phone?: string; 
    notes?: string;
    sessionId?: string;
  }) {
    const { data } = await this.client.post('/public/join', payload);
    return data;
  }

  // Get all tickets for a session
  async getSessionTickets(sessionId: string) {
    const { data } = await this.client.get(`/public/session/${sessionId}/tickets`);
    return data;
  }

  // Get display data for TV screens
  async getDisplayData(locationId: string) {
    const { data } = await this.client.get(`/public/display/${locationId}`);
    return data;
  }

  async getDisplayContent(locationId: string) {
    const { data } = await this.client.get(`/public/display/${locationId}/content`);
    return data as { config: DisplayConfig; media: DisplayMediaItem[] };
  }

  async getDisplayConfig(locationId: string) {
    const { data } = await this.client.get(`/display/locations/${locationId}/config`);
    return data as DisplayConfig;
  }

  async updateDisplayConfig(locationId: string, config: DisplayConfig) {
    const { data } = await this.client.put(`/display/locations/${locationId}/config`, config);
    return data as DisplayConfig;
  }

  async listDisplayMedia() {
    const { data } = await this.client.get('/display/media');
    return data as DisplayMediaItem[];
  }

  async createDisplayMedia(item: Partial<DisplayMediaItem>) {
    const { data } = await this.client.post('/display/media', item);
    return data as DisplayMediaItem;
  }

  async uploadDisplayMedia(file: File, fields: { title?: string; durationSeconds?: number; locationId?: string | null }) {
    const form = new FormData();
    if (fields.locationId) form.append('locationId', fields.locationId);
    if (fields.title) form.append('title', fields.title);
    if (fields.durationSeconds) form.append('durationSeconds', String(fields.durationSeconds));
    form.append('file', file);
    const { data } = await this.client.post('/display/media/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } });
    return data as DisplayMediaItem;
  }

  async updateDisplayMedia(id: string, patch: Partial<DisplayMediaItem>) {
    const { data } = await this.client.patch(`/display/media/${id}`, patch);
    return data as DisplayMediaItem;
  }

  async listDisplayPlaylists() {
    const { data } = await this.client.get('/display/playlists');
    return data as DisplayPlaylist[];
  }

  async createDisplayPlaylist(body: Partial<DisplayPlaylist>) {
    const { data } = await this.client.post('/display/playlists', body);
    return data as DisplayPlaylist;
  }

  async updateDisplayPlaylist(id: string, body: Partial<DisplayPlaylist>) {
    const { data } = await this.client.patch(`/display/playlists/${id}`, body);
    return data as DisplayPlaylist;
  }

  async deleteDisplayPlaylist(id: string) {
    await this.client.delete(`/display/playlists/${id}`);
  }

  async setDisplayPlaylistItems(id: string, mediaIds: string[]) {
    const { data } = await this.client.put(`/display/playlists/${id}/items`, { mediaIds });
    return data as DisplayPlaylist;
  }

  async getDisplayEntitlement() {
    const { data } = await this.client.get('/display/entitlement');
    return data as DisplayEntitlement;
  }

  async getDisplayUploadConfig() {
    const { data } = await this.client.get('/display/upload-config');
    return data as { serverMaxBytes: number; direct: { provider: 'uploadcare'; publicKey: string; maxBytes: number } | null; largeFilesNeedPack?: boolean };
  }

  async registerDirectUpload(body: { fileId: string; mimeType?: string; size?: number; title?: string; durationSeconds?: number; locationId?: string | null }) {
    const { data } = await this.client.post('/display/media/direct', body);
    return data as DisplayMediaItem;
  }

  async reorderDisplayMedia(ids: string[]) {
    await this.client.put('/display/media/order', { items: ids.map((id) => ({ id })) });
  }

  async deleteDisplayMedia(id: string) {
    await this.client.delete(`/display/media/${id}`);
  }

  // Get queue swimlanes for a location (for display boards)
  async getLocationQueues(locationId: string) {
    const { data } = await this.client.get(`/public/queues/${locationId}`);
    return data;
  }

  // Service Points
  async getServicePoints(organizationId: string) {
    const { data } = await this.client.get(`/service-points/organization/${organizationId}`);
    return data;
  }

  async getActiveServicePoints(locationId: string) {
    const { data } = await this.client.get(`/service-points/location/${locationId}/active`);
    return data;
  }

  async getServicePointsForService(serviceId: string) {
    const { data } = await this.client.get(`/service-points/service/${serviceId}`);
    return data;
  }

  async createServicePoint(payload: {
    organizationId: string;
    name: string;
    displayName?: string;
    type?: string;
    capacity?: number;
  }) {
    const { data } = await this.client.post('/service-points', payload);
    return data;
  }

  async updateServicePoint(id: string, payload: {
    name?: string;
    displayName?: string;
    type?: string;
    capacity?: number;
    isActive?: boolean;
  }) {
    const { data } = await this.client.patch(`/service-points/${id}`, payload);
    return data;
  }

  async deleteServicePoint(id: string) {
    await this.client.delete(`/service-points/${id}`);
  }

  // Service point linking to services (admin)
  async linkServicePointToService(servicePointId: string, serviceId: string, capacity: number) {
    const { data } = await this.client.post('/service-points/link', { servicePointId, serviceId, capacity });
    return data;
  }

  async unlinkServicePointFromService(servicePointId: string, serviceId: string) {
    const { data } = await this.client.post('/service-points/unlink', { servicePointId, serviceId });
    return data;
  }

  async updateServicePointLink(linkId: string, updates: { capacity?: number | null }) {
    const { data } = await this.client.patch(`/service-points/link/${linkId}`, updates);
    return data;
  }

  // Service point activation (operator desk management) - legacy
  async activateServicePoint(servicePointId: string, serviceId: string) {
    const { data } = await this.client.post('/service-points/activate', { servicePointId, serviceId });
    return data;
  }

  async vacateServicePoint(servicePointId: string, serviceId: string) {
    const { data } = await this.client.post('/service-points/vacate', { servicePointId, serviceId });
    return data;
  }

  // Service Point Instances
  async getServicePointInstances(servicePointId: string) {
    const { data } = await this.client.get(`/service-points/${servicePointId}/instances`);
    return data;
  }

  async getServiceInstances(serviceId: string) {
    const { data } = await this.client.get(`/service-points/service/${serviceId}/instances`);
    return data;
  }

  async getLocationInstances(locationId: string) {
    const { data } = await this.client.get(`/service-points/location/${locationId}/instances`);
    return data;
  }

  async activateServicePointInstance(instanceId: string, serviceId?: string, takeOver = false) {
    const { data } = await this.client.post(`/service-points/instances/${instanceId}/activate`, { serviceId, takeOver });
    return data;
  }

  async markNoShow(queueId: string, entryId: string) {
    const { data } = await this.client.patch(`/queues/${queueId}/entry/${entryId}/no-show`);
    return data;
  }

  async vacateServicePointInstance(instanceId: string) {
    const { data } = await this.client.post(`/service-points/instances/${instanceId}/vacate`);
    return data;
  }

  async toggleInstanceActive(instanceId: string, isActive: boolean) {
    const { data } = await this.client.patch(`/service-points/instances/${instanceId}/toggle`, { isActive });
    return data;
  }

  // Service Flows (for flow designer)
  async getLocationFlows(locationId: string) {
    const { data } = await this.client.get(`/service-flows/location/${locationId}`);
    return data;
  }

  async getServiceFlows(serviceId: string) {
    const { data } = await this.client.get(`/service-flows/service/${serviceId}`);
    return data;
  }

  async getNextServices(serviceId: string) {
    const { data } = await this.client.get(`/service-flows/service/${serviceId}/next`);
    return data;
  }

  async createServiceFlow(payload: {
    fromServiceId: string;
    toServiceId: string;
    priority?: number;
    displayName?: string;
    condition?: string;
    autoTransfer?: boolean;
    isRequired?: boolean;
  }) {
    const { data } = await this.client.post('/service-flows', payload);
    return data;
  }

  async updateServiceFlow(id: string, payload: {
    priority?: number;
    displayName?: string;
    condition?: string;
    autoTransfer?: boolean;
    isRequired?: boolean;
  }) {
    const { data } = await this.client.patch(`/service-flows/${id}`, payload);
    return data;
  }

  async deleteServiceFlow(id: string) {
    await this.client.delete(`/service-flows/${id}`);
  }

  async updateFlowOrder(flows: { id: string; priority: number }[]) {
    const { data } = await this.client.patch('/service-flows/order', { flows });
    return data;
  }

  // Enhanced Queue Operations (for operators)
  async getQueueForOperator(queueId: string) {
    const { data } = await this.client.get(`/queues/${queueId}/operator`);
    return data;
  }

  async reorderQueueEntries(queueId: string, entries: { id: string; sortOrder: number }[]) {
    const { data } = await this.client.patch(`/queues/${queueId}/reorder`, { entries });
    return data;
  }

  async callNextWithServicePoint(queueId: string, servicePointInstanceId?: string, entryId?: string) {
    const { data } = await this.client.post(`/queues/${queueId}/call-next-sp`, {
      servicePointInstanceId,
      entryId,
    });
    return data;
  }

  async recallEntry(queueId: string, entryId: string) {
    const { data } = await this.client.post(`/queues/${queueId}/entry/${entryId}/recall`);
    return data;
  }

  /** Put the person being served on hold (the desk is free for the next one). */
  async holdEntry(queueId: string, entryId: string): Promise<{ changed: boolean }> {
    const { data } = await this.client.post(`/queues/${queueId}/entry/${entryId}/hold`);
    return data;
  }

  /** Call someone on hold back, to this desk (or the one they were held at). */
  async resumeEntry(queueId: string, entryId: string, servicePointInstanceId?: string): Promise<{ changed: boolean }> {
    const { data } = await this.client.post(`/queues/${queueId}/entry/${entryId}/resume`, { servicePointInstanceId });
    return data;
  }

  /** Mark someone waiting for payment as paid, so they can be called. */
  async clearEntry(queueId: string, entryId: string): Promise<{ changed: boolean }> {
    const { data } = await this.client.post(`/queues/${queueId}/entry/${entryId}/clear`);
    return data;
  }

  async getPublicCurrencies(): Promise<{ base: string; currencies: string[] }> {
    const { data } = await this.client.get('/public/currencies');
    return data;
  }

  async getCurrencySettings(): Promise<CurrencySettings> {
    const { data } = await this.client.get('/superadmin/currencies');
    return data;
  }

  async updateCurrencySettings(rates: Record<string, number>, autoRefresh?: boolean) {
    const { data } = await this.client.put('/superadmin/currencies', { rates, ...(autoRefresh === undefined ? {} : { autoRefresh }) });
    return data as { base: string; rates: Record<string, number> };
  }

  async refreshCurrencyRates() {
    const { data } = await this.client.post('/superadmin/currencies/refresh');
    return data as { updated: string[]; unavailable: string[]; base: string; rates: Record<string, number>; refreshedAt: string };
  }

  async setOrganizationCurrency(organizationId: string, currency: string) {
    const { data } = await this.client.patch(`/superadmin/organizations/${organizationId}/currency`, { currency });
    return data as { currency: string };
  }

  // Rooms, tables and floor plans
  async listRooms(locationId: string): Promise<{ features: { rooms: boolean; tables: boolean }; rooms: (RoomRow & { seats: number; _count: { tables: number; instances: number; services: number } })[] }> {
    const { data } = await this.client.get('/rooms', { params: { locationId } });
    return data;
  }

  async getRoom(id: string): Promise<{ room: RoomRow; tables: RoomTableRow[]; deskIds: string[] }> {
    const { data } = await this.client.get(`/rooms/${id}`);
    return data;
  }

  async createRoom(body: Partial<RoomRow> & { locationId: string; name: string }): Promise<RoomRow> {
    const { data } = await this.client.post('/rooms', body);
    return data;
  }

  async updateRoom(id: string, body: Partial<RoomRow>): Promise<RoomRow> {
    const { data } = await this.client.put(`/rooms/${id}`, body);
    return data;
  }

  async deleteRoom(id: string) {
    const { data } = await this.client.delete(`/rooms/${id}`);
    return data;
  }

  async saveRoomLayout(id: string, body: { layoutWidth: number; layoutHeight: number; tables: unknown[] }): Promise<{ tables: RoomTableRow[]; layoutWidth: number; layoutHeight: number }> {
    const { data } = await this.client.put(`/rooms/${id}/layout`, body);
    return data;
  }

  async uploadRoomImage(id: string, file: File): Promise<{ layoutImageUrl: string }> {
    const form = new FormData();
    form.append('image', file);
    const { data } = await this.client.post(`/rooms/${id}/image`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
    return data;
  }

  async removeRoomImage(id: string) {
    const { data } = await this.client.delete(`/rooms/${id}/image`);
    return data;
  }

  async listDesks(locationId: string): Promise<{ id: string; name: string; serviceName: string; roomId: string | null }[]> {
    const { data } = await this.client.get('/rooms/desks', { params: { locationId } });
    return data;
  }

  async setRoomDesks(id: string, instanceIds: string[]) {
    const { data } = await this.client.put(`/rooms/${id}/desks`, { instanceIds });
    return data;
  }

  async getRoomFloor(id: string, at: string, minutes = 90): Promise<FloorMap> {
    const { data } = await this.client.get(`/rooms/${id}/floor`, { params: { at, minutes } });
    return data;
  }

  async getRoomSeatMap(id: string, params: { start: string; minutes?: number; partySize?: number; excludeAppointmentId?: string }): Promise<FloorMap> {
    const { data } = await this.client.get(`/rooms/${id}/seat-map`, { params });
    return data;
  }

  async setAppointmentTables(appointmentId: string, tableIds: string[], confirmPrice = false) {
    const { data } = await this.client.put(`/appointments/${appointmentId}/tables`, { tableIds, ...(confirmPrice ? { confirmPrice } : {}) });
    return data;
  }

  // Booking payments (organization admin)
  async getPaymentsOverview(): Promise<PaymentsOverview> {
    const { data } = await this.client.get('/payments');
    return data;
  }

  async updatePaymentSettings(body: { currency?: string; payoutDetails?: string }) {
    const { data } = await this.client.put('/payments/settings', body);
    return data;
  }

  async saveOwnPaymentProvider(provider: 'stripe' | 'paystack', body: { publicKey?: string; secretKey?: string; webhookSecret?: string; isActive?: boolean }) {
    const { data } = await this.client.put(`/payments/providers/${provider}`, body);
    return data;
  }

  async removeOwnPaymentProvider(provider: 'stripe' | 'paystack') {
    const { data } = await this.client.delete(`/payments/providers/${provider}`);
    return data;
  }

  async requestPayout(amount?: number) {
    const { data } = await this.client.post('/payments/payouts', { amount });
    return data as { id: string; amount: number; currency: string; status: string };
  }

  // Payouts (superadmin)
  async getPayoutSettings(): Promise<{ holdDays: number; feePercent: number; minPayout: number }> {
    const { data } = await this.client.get('/superadmin/payout-settings');
    return data;
  }

  async updatePayoutSettings(body: { holdDays: number; feePercent: number; minPayout: number }) {
    const { data } = await this.client.put('/superadmin/payout-settings', body);
    return data as { holdDays: number; feePercent: number; minPayout: number };
  }

  async listPayoutRequests(status?: string): Promise<PayoutRequestRow[]> {
    const { data } = await this.client.get('/superadmin/payouts', { params: status ? { status } : {} });
    return data;
  }

  async decidePayout(id: string, action: 'PAID' | 'REJECTED', note?: string) {
    const { data } = await this.client.post(`/superadmin/payouts/${id}/decision`, { action, note });
    return data;
  }

  // One-off sessions (events, classes, tickets)
  async getServiceSessions(serviceId: string): Promise<ServiceSession[]> {
    const { data } = await this.client.get(`/services/${serviceId}/sessions`);
    return data;
  }

  async createServiceSession(serviceId: string, body: { date: string; startTime: string; durationMinutes?: number; capacity: number; price?: number | null; label?: string }): Promise<ServiceSession> {
    const { data } = await this.client.post(`/services/${serviceId}/sessions`, body);
    return data;
  }

  async deleteServiceSession(serviceId: string, slotId: string) {
    const { data } = await this.client.delete(`/services/${serviceId}/sessions/${slotId}`);
    return data;
  }

  // Booking payments (organization admin)
  async getPaymentsOverview(): Promise<PaymentsOverview> {
    const { data } = await this.client.get('/payments');
    return data;
  }

  async updatePaymentSettings(body: { currency?: string; payoutDetails?: string }) {
    const { data } = await this.client.put('/payments/settings', body);
    return data;
  }

  async saveOwnPaymentProvider(provider: 'stripe' | 'paystack', body: { publicKey?: string; secretKey?: string; webhookSecret?: string; isActive?: boolean }) {
    const { data } = await this.client.put(`/payments/providers/${provider}`, body);
    return data;
  }

  async removeOwnPaymentProvider(provider: 'stripe' | 'paystack') {
    const { data } = await this.client.delete(`/payments/providers/${provider}`);
    return data;
  }

  async requestPayout(amount?: number) {
    const { data } = await this.client.post('/payments/payouts', { amount });
    return data as { id: string; amount: number; currency: string; status: string };
  }

  // Payouts (superadmin)
  async getPayoutSettings(): Promise<{ holdDays: number; feePercent: number; minPayout: number }> {
    const { data } = await this.client.get('/superadmin/payout-settings');
    return data;
  }

  async updatePayoutSettings(body: { holdDays: number; feePercent: number; minPayout: number }) {
    const { data } = await this.client.put('/superadmin/payout-settings', body);
    return data as { holdDays: number; feePercent: number; minPayout: number };
  }

  async listPayoutRequests(status?: string): Promise<PayoutRequestRow[]> {
    const { data } = await this.client.get('/superadmin/payouts', { params: status ? { status } : {} });
    return data;
  }

  async decidePayout(id: string, action: 'PAID' | 'REJECTED', note?: string) {
    const { data } = await this.client.post(`/superadmin/payouts/${id}/decision`, { action, note });
    return data;
  }

  // One-off sessions (events, classes, tickets)
  async getServiceSessions(serviceId: string): Promise<ServiceSession[]> {
    const { data } = await this.client.get(`/services/${serviceId}/sessions`);
    return data;
  }

  async createServiceSession(serviceId: string, body: { date: string; startTime: string; durationMinutes?: number; capacity: number; price?: number | null; label?: string }): Promise<ServiceSession> {
    const { data } = await this.client.post(`/services/${serviceId}/sessions`, body);
    return data;
  }

  async deleteServiceSession(serviceId: string, slotId: string) {
    const { data } = await this.client.delete(`/services/${serviceId}/sessions/${slotId}`);
    return data;
  }

  async getFlowTemplates(): Promise<FlowTemplateInfo[]> {
    const { data } = await this.client.get('/service-flows/templates');
    return data;
  }

  async applyFlowTemplate(templateId: string, locationId: string): Promise<{ services: { id: string; name: string; created: boolean }[]; servicePointsCreated: number; flowsCreated: number; defaultServiceId: string; roomsCreated: number; tablesCreated: number; tablesSkipped: boolean }> {
    const { data } = await this.client.post(`/service-flows/templates/${templateId}/apply`, { locationId });
    return data;
  }

  async transferEntry(queueId: string, entryId: string, serviceId: string): Promise<{ entry?: { id: string }; ticketNumber: string; serviceName: string; queueId: string }> {
    const { data } = await this.client.post(`/queues/${queueId}/entry/${entryId}/transfer`, { serviceId });
    return data;
  }

  // Integrations: outbound webhooks + audit log
  async getWebhookEvents(): Promise<string[]> {
    const { data } = await this.client.get('/webhook-events');
    return data;
  }

  async getWebhooks(organizationId: string): Promise<WebhookEndpoint[]> {
    const { data } = await this.client.get(`/orgs/${organizationId}/webhooks`);
    return data;
  }

  async createWebhook(organizationId: string, payload: { url: string; description?: string; events: string[] }): Promise<WebhookEndpoint & { secret: string }> {
    const { data } = await this.client.post(`/orgs/${organizationId}/webhooks`, payload);
    return data;
  }

  async updateWebhook(id: string, payload: { url?: string; description?: string; events?: string[]; isActive?: boolean }): Promise<WebhookEndpoint> {
    const { data } = await this.client.patch(`/webhooks/${id}`, payload);
    return data;
  }

  async rotateWebhookSecret(id: string): Promise<WebhookEndpoint & { secret: string }> {
    const { data } = await this.client.post(`/webhooks/${id}/rotate-secret`);
    return data;
  }

  async testWebhook(id: string): Promise<{ status: string; responseCode: number | null; error: string | null }> {
    const { data } = await this.client.post(`/webhooks/${id}/test`);
    return data;
  }

  async deleteWebhook(id: string) {
    await this.client.delete(`/webhooks/${id}`);
  }

  async getWebhookDeliveries(id: string): Promise<WebhookDelivery[]> {
    const { data } = await this.client.get(`/webhooks/${id}/deliveries`);
    return data;
  }

  async getEmrIntegrations(organizationId: string): Promise<EmrIntegration[]> {
    const { data } = await this.client.get(`/orgs/${organizationId}/emr-integrations`);
    return data;
  }

  async createEmrIntegration(organizationId: string, name: string): Promise<EmrIntegration & { apiKey: string }> {
    const { data } = await this.client.post(`/orgs/${organizationId}/emr-integrations`, { name });
    return data;
  }

  async getEmrIntegration(id: string): Promise<EmrIntegrationDetail> {
    const { data } = await this.client.get(`/emr-integrations/${id}`);
    return data;
  }

  async rotateEmrIntegrationKey(id: string): Promise<EmrIntegration & { apiKey: string }> {
    const { data } = await this.client.post(`/emr-integrations/${id}/rotate-key`);
    return data;
  }

  async revokeEmrIntegration(id: string): Promise<EmrIntegration> {
    const { data } = await this.client.post(`/emr-integrations/${id}/revoke`);
    return data;
  }

  async setEmrMapping(id: string, payload: { resourceType: EmrMappableType; resourceId: string; externalId: string | null }) {
    const { data } = await this.client.put(`/emr-integrations/${id}/mappings`, payload);
    return data as { resourceType: EmrMappableType; klargyId: string; externalId: string | null };
  }

  async getAuditLogs(organizationId: string, params?: { action?: string; before?: string; limit?: number }): Promise<{ logs: AuditLogEntry[]; nextCursor: string | null }> {
    const { data } = await this.client.get(`/orgs/${organizationId}/audit-logs`, { params });
    return data;
  }

  // AI-assisted analytics (provider-agnostic)
  async getAiStatus(): Promise<AiStatus> {
    const { data } = await this.client.get('/ai/status');
    return data;
  }

  async updateAiSettings(enabled: boolean): Promise<{ enabled: boolean }> {
    const { data } = await this.client.put('/ai/settings', { enabled });
    return data;
  }

  async askAi(question: string, locationId?: string): Promise<AiInsight & { creditsRemaining: number | null }> {
    const { data } = await this.client.post('/ai/ask', { question, locationId });
    return data;
  }

  async getAiInsights(kind?: 'ASK' | 'DIGEST', limit = 10): Promise<AiInsight[]> {
    const { data } = await this.client.get('/ai/insights', { params: { kind, limit } });
    return data;
  }

  async getWaitForecast(serviceId: string) {
    const { data } = await this.client.get(`/ai/forecast/${serviceId}`);
    return data;
  }

  async getWaitAlerts(locationId: string): Promise<WaitAlert[]> {
    const { data } = await this.client.get('/ai/alerts', { params: { locationId } });
    return data;
  }

  async getAiProviders(): Promise<AiProviderConfig[]> {
    const { data } = await this.client.get('/superadmin/ai-providers');
    return data;
  }

  async saveAiProvider(provider: string, payload: { apiKey?: string; model?: string; baseUrl?: string; isActive: boolean }) {
    const { data } = await this.client.put(`/superadmin/ai-providers/${provider}`, payload);
    return data;
  }

  /** Tests the given (possibly unsaved) values; empty fields fall back to the saved config. */
  async testAiProvider(
    provider: string,
    payload: { apiKey?: string; model?: string; baseUrl?: string } = {}
  ): Promise<{ ok: boolean; model?: string; api?: string | null; latencyMs?: number; reply?: string; error?: string }> {
    const { data } = await this.client.post(`/superadmin/ai-providers/${provider}/test`, payload);
    return data;
  }

  async completeEntryWithSuggestions(queueId: string, entryId: string) {
    const { data } = await this.client.patch(`/queues/${queueId}/entry/${entryId}/complete`);
    return data;
  }

  // Public organization registration (SaaS flow)
  async registerOrganization(payload: {
    organizationName: string;
    email: string;
    phone?: string;
    adminFirstName: string;
    adminLastName: string;
    adminPassword: string;
    emailVerified?: boolean;
    slug?: string;
    currency?: string;
  }) {
    const { data } = await this.client.post('/public/register-org', payload);
    return data;
  }

  async listSmsProviders() {
    const { data } = await this.client.get('/superadmin/sms-providers');
    return data;
  }

  async saveSmsProvider(provider: string, body: { accountId: string; secret?: string; senderId?: string; isActive: boolean }) {
    const { data } = await this.client.put(`/superadmin/sms-providers/${provider}`, body);
    return data;
  }

  async testSmsProvider(provider: string, to: string) {
    const { data } = await this.client.post(`/superadmin/sms-providers/${provider}/test`, { to });
    return data;
  }

  async getOnboardingStatus(): Promise<{ locations: number; services: number; desks: number; entries: number; needsSetup: boolean; firstLocation: { id: string; name: string; publicCode: string | null } | null }> {
    const { data } = await this.client.get('/onboarding/status');
    return data;
  }

  async quickStart(payload: { locationName: string; services: string[]; startTime: string; endTime: string; activeDays: string; timezone?: string; industry?: string; currency?: string }): Promise<{ location: { id: string; name: string; publicCode: string }; services: { id: string; name: string; desk: string }[] }> {
    const { data } = await this.client.post('/onboarding/quick-start', payload);
    return data;
  }

  async getPublicOrganization(orgId: string) {
    const { data } = await this.client.get(`/public/orgs/${orgId}`);
    return data;
  }

  async getPublicLocationServices(orgId: string, locationId: string) {
    const { data } = await this.client.get(`/public/orgs/${orgId}/locations/${locationId}/services`);
    return data;
  }

  // Get location info by internal ID (for display boards)
  async getPublicLocationInfo(locationId: string) {
    const { data } = await this.client.get(`/public/location-info/${locationId}`);
    return data;
  }

  // OTP verification
  async sendOTP(email: string) {
    const { data } = await this.client.post('/public/send-otp', { email });
    return data;
  }

  async verifyOTP(email: string, code: string) {
    const { data } = await this.client.post('/public/verify-otp', { email, code });
    return data;
  }

  // Organization management
  async updateOrganization(id: string, payload: { 
    name?: string; 
    email?: string; 
    phone?: string; 
    slug?: string;
    identityFieldsConfig?: Record<string, { required: boolean; label: string; type?: string }>;
    defaultDisplayMode?: string;
    primaryColor?: string | null;
    hidePoweredBy?: boolean;
    notificationSettings?: NotificationSettings;
    bookedArrivalSettings?: BookedArrivalSettings;
  }) {
    const { data } = await this.client.put(`/orgs/${id}`, payload);
    return data;
  }

  // Data Sources
  async getDataSources(organizationId: string) {
    const { data } = await this.client.get(`/orgs/${organizationId}/data-sources`);
    return data;
  }

  async getDataSource(id: string) {
    const { data } = await this.client.get(`/data-sources/${id}`);
    return data;
  }

  async createDataSource(organizationId: string, source: {
    name: string;
    description?: string;
    type: 'API' | 'DATABASE' | 'FILE' | 'WEBHOOK';
    config: Record<string, unknown>;
    isActive?: boolean;
  }) {
    const { data } = await this.client.post(`/orgs/${organizationId}/data-sources`, source);
    return data;
  }

  async updateDataSource(id: string, payload: {
    name?: string;
    description?: string;
    type?: 'API' | 'DATABASE' | 'FILE' | 'WEBHOOK';
    config?: Record<string, unknown>;
    isActive?: boolean;
  }) {
    const { data } = await this.client.put(`/data-sources/${id}`, payload);
    return data;
  }

  async deleteDataSource(id: string) {
    await this.client.delete(`/data-sources/${id}`);
  }

  async testDataSource(id: string, testParams?: Record<string, unknown>) {
    const { data } = await this.client.post(`/data-sources/${id}/test`, testParams || {});
    return data;
  }

  // Field Mappings
  async getFieldMappings(dataSourceId: string) {
    const { data } = await this.client.get(`/data-sources/${dataSourceId}/mappings`);
    return data;
  }

  async createFieldMapping(dataSourceId: string, mapping: {
    sourcePath: string;
    targetField: string;
    transform?: string;
  }) {
    const { data } = await this.client.post(`/data-sources/${dataSourceId}/mappings`, mapping);
    return data;
  }

  async updateFieldMapping(id: string, payload: {
    sourcePath?: string;
    targetField?: string;
    transform?: string;
  }) {
    const { data } = await this.client.put(`/field-mappings/${id}`, payload);
    return data;
  }

  async deleteFieldMapping(id: string) {
    await this.client.delete(`/field-mappings/${id}`);
  }

  // Location management
  async deleteLocation(id: string) {
    await this.client.delete(`/locations/${id}`);
  }

  // Service management
  async updateService(id: string, payload: Partial<Service> & {
    servicePoints?: { servicePointId: string; capacity: number }[];
  }) {
    const { data } = await this.client.put(`/services/${id}`, payload);
    return data;
  }

  async deleteService(id: string) {
    await this.client.delete(`/services/${id}`);
  }

  // Dashboard stats
  async getDashboardStats(organizationId: string) {
    // Aggregate stats from locations, services, queues
    const locations = await this.getLocations(organizationId);
    let totalServices = 0;
    let activeQueues = 0;
    let todayServed = 0;

    for (const loc of locations) {
      const services = await this.getServices(loc.id);
      totalServices += services.length;

      for (const svc of services) {
        try {
          const today = new Date().toISOString().split('T')[0];
          const queues = await this.getServiceQueues(svc.id, today);
          if (queues && queues.length > 0) {
            for (const q of queues) {
              if (q.status === 'ACTIVE') activeQueues++;
              if (q.entries) {
                todayServed += q.entries.filter((e: any) => e.status === 'SERVED').length;
              }
            }
          }
        } catch { /* ignore */ }
      }
    }

    return {
      locations: locations.length,
      services: totalServices,
      activeQueues,
      todayServed
    };
  }

  // =====================================================
  // SUPERADMIN API
  // =====================================================

  // Dashboard
  async getSuperadminDashboard() {
    const { data } = await this.client.get('/superadmin/dashboard');
    return data;
  }

  // Organizations
  async getSuperadminOrganizations(params?: { search?: string; status?: string; planId?: string; page?: number; limit?: number }) {
    const { data } = await this.client.get('/superadmin/organizations', { params });
    return data;
  }

  async getSuperadminOrganization(id: string) {
    const { data } = await this.client.get(`/superadmin/organizations/${id}`);
    return data;
  }

  async getSuperadminOrganizationUsage(id: string) {
    const { data } = await this.client.get(`/superadmin/organizations/${id}/usage`);
    return data;
  }

  async updateOrganizationSubscription(id: string, payload: {
    planId?: string;
    status?: string;
    billingCycle?: string;
    trialEndsAt?: string;
    externalProviderSubscriptionId?: string;
  }) {
    const { data } = await this.client.patch(`/superadmin/organizations/${id}/subscription`, payload);
    return data;
  }

  async cancelOrganizationSubscription(id: string, reason?: string) {
    const { data } = await this.client.post(`/superadmin/organizations/${id}/cancel`, { reason });
    return data;
  }

  async deleteSuperadminOrganization(id: string) {
    const { data } = await this.client.delete(`/superadmin/organizations/${id}`, { data: { confirm: 'DELETE' } });
    return data;
  }

  async setOrganizationStatus(id: string, status: 'ACTIVE' | 'PAUSED') {
    const { data } = await this.client.patch(`/superadmin/organizations/${id}/status`, { status });
    return data;
  }

  async impersonateOrganization(id: string) {
    const { data } = await this.client.post(`/superadmin/organizations/${id}/impersonate`);
    return data as {
      token: string;
      tenantSlug: string;
      organizationName: string;
      impersonatedUser: { email: string; firstName: string; lastName: string; role: string };
    };
  }

  // Subscription Plans
  async getSubscriptionPlans(includeInactive?: boolean) {
    const { data } = await this.client.get('/superadmin/plans', { params: { includeInactive } });
    return data;
  }

  async createSubscriptionPlan(payload: {
    name: string;
    code: string;
    description?: string;
    priceMonthly?: number;
    priceQuarterly?: number;
    priceYearly?: number;
    currency?: string;
    maxLocations?: number | null;
    maxServicesPerLoc?: number | null;
    maxUsersPerOrg?: number | null;
    maxQueueEntriesPerDay?: number | null;
    features?: Record<string, boolean | number>;
    displayOrder?: number;
    tierRank?: number;
    isDefault?: boolean;
    isRecommended?: boolean;
    trialDurationDays?: number | null;
    expiredFallbackPlanId?: string | null;
    upgradePlanId?: string | null;
    creditAllowances?: Partial<Record<'AI' | 'EMAIL' | 'SMS', number | null>>;
    addOnPricingOverrides?: Partial<Record<'LOCATIONS' | 'USERS', { pricePerUnitMonthly: number; pricePerUnitOneOff: number } | null>>;
    currencyPrices?: { currency: string; priceMonthly: number; priceQuarterly: number; priceYearly: number }[];
  }) {
    const { data } = await this.client.post('/superadmin/plans', payload);
    return data;
  }

  async updateSubscriptionPlan(id: string, payload: {
    name?: string;
    description?: string;
    priceMonthly?: number;
    priceQuarterly?: number;
    priceYearly?: number;
    currency?: string;
    maxLocations?: number | null;
    maxServicesPerLoc?: number | null;
    maxUsersPerOrg?: number | null;
    maxQueueEntriesPerDay?: number | null;
    features?: Record<string, boolean | number>;
    displayOrder?: number;
    tierRank?: number;
    isActive?: boolean;
    isDefault?: boolean;
    isRecommended?: boolean;
    trialDurationDays?: number | null;
    expiredFallbackPlanId?: string | null;
    upgradePlanId?: string | null;
    creditAllowances?: Partial<Record<'AI' | 'EMAIL' | 'SMS', number | null>>;
    addOnPricingOverrides?: Partial<Record<'LOCATIONS' | 'USERS', { pricePerUnitMonthly: number; pricePerUnitOneOff: number } | null>>;
    currencyPrices?: { currency: string; priceMonthly: number; priceQuarterly: number; priceYearly: number }[];
  }) {
    const { data } = await this.client.patch(`/superadmin/plans/${id}`, payload);
    return data;
  }

  async grantCredits(organizationId: string, payload: { creditType: 'AI' | 'EMAIL' | 'SMS'; amount: number; reason: string }) {
    const { data } = await this.client.post(`/superadmin/organizations/${organizationId}/credits/grant`, payload);
    return data;
  }

  async getOrganizationWallet(organizationId: string) {
    const { data } = await this.client.get(`/superadmin/organizations/${organizationId}/wallet`);
    return data as WalletSummary;
  }

  async adjustOrganizationWallet(organizationId: string, payload: { amount: number; reason: string; currency?: string }) {
    const { data } = await this.client.post(`/superadmin/organizations/${organizationId}/wallet/adjust`, payload);
    return data as WalletSummary & { subscriptionUpdated: boolean };
  }

  async bumpOrganizationPlan(organizationId: string, payload: {
    planId: string;
    until: string;
    endBehavior: 'REVERT' | 'KEEP_AT_CUSTOM_PRICE';
    customPrice?: number | null;
    billingCycle?: string;
  }) {
    const { data } = await this.client.post(`/superadmin/organizations/${organizationId}/subscription/bump`, payload);
    return data as WalletSummary;
  }

  async endOrganizationPlanBump(organizationId: string) {
    const { data } = await this.client.post(`/superadmin/organizations/${organizationId}/subscription/bump/end`);
    return data as WalletSummary;
  }

  async deleteSubscriptionPlan(id: string) {
    const { data } = await this.client.delete(`/superadmin/plans/${id}`);
    return data;
  }

  async getPaymentProviders() {
    const { data } = await this.client.get('/superadmin/payment-providers');
    return data;
  }

  async savePaymentProvider(provider: 'stripe' | 'paystack', payload: { publicKey?: string; secretKey: string; webhookSecret: string; isActive: boolean }) {
    const { data } = await this.client.put(`/superadmin/payment-providers/${provider}`, payload);
    return data;
  }

  async testPaymentProvider(provider: 'stripe' | 'paystack') {
    const { data } = await this.client.post(`/superadmin/payment-providers/${provider}/test`);
    return data;
  }
}

export const api = new ApiClient();
export default api;
