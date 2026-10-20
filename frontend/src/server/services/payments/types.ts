export type ProviderName = 'stripe' | 'paystack';

export interface CreateCheckoutParams {
  organizationId: string;
  planId: string;
  planCode: string;
  planName: string;
  amount: number; // in the plan's base currency unit (e.g. dollars, not cents)
  currency: string;
  billingCycle: 'monthly' | 'quarterly' | 'yearly';
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  redirectUrl: string;
}

export type AddOnResourceType = 'LOCATIONS' | 'USERS' | 'DISPLAY_MEDIA';
export const ADDON_RESOURCE_TYPES: AddOnResourceType[] = ['LOCATIONS', 'USERS', 'DISPLAY_MEDIA'];

/** How an add-on is named on invoices and checkout pages. */
export function addOnProductName(resourceType: AddOnResourceType, quantity: number): string {
  if (resourceType === 'DISPLAY_MEDIA') return `${quantity}x lobby media pack`;
  const label = resourceType === 'LOCATIONS' ? 'location' : 'user';
  return `${quantity}x extra ${label}${quantity > 1 ? 's' : ''}`;
}
export type AddOnBillingMode = 'recurring' | 'one_off';

export interface CreateAddOnCheckoutParams {
  organizationId: string;
  resourceType: AddOnResourceType;
  quantity: number;
  billingMode: AddOnBillingMode;
  unitPrice: number; // resolved from AddOnPricing before calling the provider
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

export type PaymentWebhookEventType =
  | 'checkout_completed'
  | 'renewal_succeeded'
  | 'renewal_failed'
  | 'subscription_cancelled';

export interface PaymentWebhookEvent {
  eventId: string;
  type: PaymentWebhookEventType;
  organizationId: string | null;
  externalSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  planId: string | null;
  billingCycle: 'monthly' | 'quarterly' | 'yearly' | null;
  kind: 'plan' | 'addon';
  // What the customer actually paid (major units) - credited to their wallet.
  // Null/absent when nothing should be credited (e.g. Stripe's first invoice,
  // which is already covered by the checkout event).
  amount?: number | null;
  currency?: string | null;
  addOn?: { resourceType: AddOnResourceType; quantity: number; billingMode: AddOnBillingMode };
}

export interface PaymentProvider {
  name: ProviderName;
  createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutResult>;
  createAddOnCheckoutSession(params: CreateAddOnCheckoutParams): Promise<CheckoutResult>;
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): PaymentWebhookEvent | null;
  cancelSubscription(externalSubscriptionId: string): Promise<void>;
}

export class ProviderNotActiveError extends Error {
  constructor(provider: string) {
    super(`Payment provider "${provider}" is not configured or not active`);
    this.name = 'ProviderNotActiveError';
  }
}
