import Stripe from 'stripe';
import { addOnProductName } from './types';
import { PaymentProvider, CreateCheckoutParams, CreateAddOnCheckoutParams, CheckoutResult, PaymentWebhookEvent } from './types';

// Stripe's `recurring.interval` has no native "quarter" value - quarterly
// billing is expressed as 3 one-month intervals. Exported for testing.
export function resolveStripeInterval(billingCycle: 'monthly' | 'quarterly' | 'yearly'): { interval: 'month' | 'year'; interval_count: number } {
  if (billingCycle === 'yearly') return { interval: 'year', interval_count: 1 };
  if (billingCycle === 'quarterly') return { interval: 'month', interval_count: 3 };
  return { interval: 'month', interval_count: 1 };
}

// Since Stripe API 2025-03-31 ("basil") an invoice no longer has a top-level
// `subscription`; it lives under `parent.subscription_details`.
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  if (!sub) return null;
  return typeof sub === 'string' ? sub : sub.id;
}

export class StripeProvider implements PaymentProvider {
  name = 'stripe' as const;
  private client: Stripe;
  private webhookSecret: string;

  constructor(secretKey: string, webhookSecret: string, _publicKey?: string | null) {
    // No explicit apiVersion pinned — uses the Stripe account's configured
    // default API version, avoiding a hardcoded literal that this SDK's
    // types would otherwise force to track every Stripe API release.
    this.client = new Stripe(secretKey);
    this.webhookSecret = webhookSecret;
  }

  async createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutResult> {
    const session = await this.client.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        {
          price_data: {
            currency: params.currency.toLowerCase(),
            product_data: { name: `${params.planName} (${params.billingCycle})` },
            unit_amount: Math.round(params.amount * 100),
            recurring: resolveStripeInterval(params.billingCycle),
          },
          quantity: 1,
        },
      ],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: {
        organizationId: params.organizationId,
        planId: params.planId,
        billingCycle: params.billingCycle,
      },
    });

    if (!session.url) {
      throw new Error('Stripe did not return a checkout URL');
    }
    return { redirectUrl: session.url };
  }

  async createAddOnCheckoutSession(params: CreateAddOnCheckoutParams): Promise<CheckoutResult> {
    const productName = addOnProductName(params.resourceType, params.quantity);
    const metadata = {
      kind: 'addon',
      organizationId: params.organizationId,
      resourceType: params.resourceType,
      quantity: String(params.quantity),
      billingMode: params.billingMode,
    };

    const session = await this.client.checkout.sessions.create({
      mode: params.billingMode === 'recurring' ? 'subscription' : 'payment',
      line_items: [
        {
          price_data: {
            currency: params.currency.toLowerCase(),
            product_data: { name: productName },
            unit_amount: Math.round(params.unitPrice * 100),
            ...(params.billingMode === 'recurring' ? { recurring: { interval: 'month' as const } } : {}),
          },
          quantity: params.quantity,
        },
      ],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata,
      // Also copied onto the resulting Subscription so it's available on
      // future invoice/subscription webhook events for this add-on, even
      // though the primary dispatch for those events is record-based (see
      // paymentWebhook.controller.ts).
      ...(params.billingMode === 'recurring' ? { subscription_data: { metadata } } : {}),
    });

    if (!session.url) {
      throw new Error('Stripe did not return a checkout URL');
    }
    return { redirectUrl: session.url };
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): PaymentWebhookEvent | null {
    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
    } catch (err) {
      console.error('Stripe webhook signature verification failed:', err);
      return null;
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const externalSubscriptionId = typeof session.subscription === 'string' ? session.subscription : null;

        if (session.metadata?.kind === 'addon') {
          const resourceType = session.metadata?.resourceType;
          const billingMode = session.metadata?.billingMode;
          const quantity = Number(session.metadata?.quantity ?? '0');
          return {
            eventId: event.id,
            type: 'checkout_completed',
            organizationId: session.metadata?.organizationId ?? null,
            externalSubscriptionId,
            currentPeriodEnd: null,
            planId: null,
            billingCycle: null,
            kind: 'addon',
            addOn: (resourceType === 'LOCATIONS' || resourceType === 'USERS' || resourceType === 'DISPLAY_MEDIA') && (billingMode === 'recurring' || billingMode === 'one_off')
              ? { resourceType, quantity, billingMode }
              : undefined,
          };
        }

        const billingCycle = session.metadata?.billingCycle;
        return {
          eventId: event.id,
          type: 'checkout_completed',
          organizationId: session.metadata?.organizationId ?? null,
          externalSubscriptionId,
          currentPeriodEnd: null,
          planId: session.metadata?.planId ?? null,
          billingCycle: billingCycle === 'monthly' || billingCycle === 'quarterly' || billingCycle === 'yearly' ? billingCycle : null,
          kind: 'plan',
          amount: session.payment_status === 'paid' && session.amount_total ? session.amount_total / 100 : null,
          currency: session.currency ? session.currency.toUpperCase() : null,
        };
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = invoiceSubscriptionId(invoice);
        return {
          eventId: event.id,
          type: 'renewal_succeeded',
          organizationId: null,
          externalSubscriptionId: subId,
          currentPeriodEnd: invoice.lines.data[0]?.period?.end
            ? new Date(invoice.lines.data[0].period.end * 1000)
            : null,
          planId: null,
          billingCycle: null,
          // Renewal/cancellation events are dispatched by looking up which
          // table externalSubscriptionId matches (see
          // paymentWebhook.controller.ts) rather than trusting this field -
          // Stripe doesn't reliably surface the originating checkout's
          // metadata on every subsequent invoice/subscription event.
          kind: 'plan',
          // The first invoice of a subscription is the checkout payment, already credited
          amount: invoice.billing_reason === 'subscription_create' ? null : invoice.amount_paid / 100,
          currency: invoice.currency ? invoice.currency.toUpperCase() : null,
        };
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = invoiceSubscriptionId(invoice);
        return {
          eventId: event.id,
          type: 'renewal_failed',
          organizationId: null,
          externalSubscriptionId: subId,
          currentPeriodEnd: null,
          planId: null,
          billingCycle: null,
          kind: 'plan',
        };
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        return {
          eventId: event.id,
          type: 'subscription_cancelled',
          organizationId: null,
          externalSubscriptionId: sub.id,
          currentPeriodEnd: null,
          planId: null,
          billingCycle: null,
          kind: 'plan',
        };
      }
      default:
        return null;
    }
  }

  async cancelSubscription(externalSubscriptionId: string): Promise<void> {
    await this.client.subscriptions.cancel(externalSubscriptionId);
  }
}
