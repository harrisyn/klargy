import crypto from 'crypto';
import { addOnProductName } from './types';
import { PaymentProvider, CreateCheckoutParams, CreateAddOnCheckoutParams, CheckoutResult, PaymentWebhookEvent } from './types';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

export class PaystackProvider implements PaymentProvider {
  name = 'paystack' as const;
  private secretKey: string;
  private webhookSecret: string;

  constructor(secretKey: string, webhookSecret: string) {
    this.secretKey = secretKey;
    this.webhookSecret = webhookSecret;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    const body = (await res.json()) as { status?: boolean; message?: string; data?: unknown };
    if (!res.ok || body.status === false) {
      throw new Error(`Paystack API error: ${body.message || res.statusText}`);
    }
    return body.data as T;
  }

  async createCheckoutSession(params: CreateCheckoutParams): Promise<CheckoutResult> {
    // Paystack works in the smallest currency unit (kobo for NGN, pesewas for GHS, cents for USD)
    const amountMinorUnits = Math.round(params.amount * 100);

    const data = await this.request<{ authorization_url: string }>('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        amount: amountMinorUnits,
        currency: params.currency.toUpperCase(),
        email: `org-${params.organizationId}@billing.internal`, // Paystack requires an email; a real one is collected via the hosted page if needed
        callback_url: params.successUrl,
        metadata: {
          organizationId: params.organizationId,
          planId: params.planId,
          billingCycle: params.billingCycle,
        },
      }),
    });

    return { redirectUrl: data.authorization_url };
  }

  async createAddOnCheckoutSession(params: CreateAddOnCheckoutParams): Promise<CheckoutResult> {
    const amountMinorUnits = Math.round(params.unitPrice * 100) * params.quantity;
    const metadata = {
      kind: 'addon',
      organizationId: params.organizationId,
      resourceType: params.resourceType,
      quantity: String(params.quantity),
      billingMode: params.billingMode,
    };

    // Paystack has no inline "arbitrary recurring amount" primitive like
    // Stripe's price_data - a Plan resource must exist first, and the
    // transaction is initialized against it to start the subscription.
    let planCode: string | undefined;
    if (params.billingMode === 'recurring') {
      const plan = await this.request<{ plan_code: string }>('/plan', {
        method: 'POST',
        body: JSON.stringify({
          name: `${addOnProductName(params.resourceType, params.quantity)} add-on`,
          amount: amountMinorUnits,
          interval: 'monthly',
          currency: params.currency.toUpperCase(),
        }),
      });
      planCode = plan.plan_code;
    }

    const data = await this.request<{ authorization_url: string }>('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        amount: amountMinorUnits,
        currency: params.currency.toUpperCase(),
        email: `org-${params.organizationId}@billing.internal`,
        callback_url: params.successUrl,
        ...(planCode ? { plan: planCode } : {}),
        metadata,
      }),
    });

    return { redirectUrl: data.authorization_url };
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): PaymentWebhookEvent | null {
    const expectedSignature = crypto
      .createHmac('sha512', this.webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (expectedSignature !== signatureHeader) {
      console.error('Paystack webhook signature verification failed');
      return null;
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    const eventId = event.data?.id ? String(event.data.id) : `${event.event}-${event.data?.reference}`;

    switch (event.event) {
      case 'charge.success': {
        const metadata = event.data?.metadata;
        // Paystack's plan-based subscriptions carry the subscription code
        // separately from the reference (which identifies this one charge);
        // recurring subscriptions carry it once created.
        const externalSubscriptionId = event.data?.plan?.plan_code
          ? (event.data?.subscription_code ?? event.data?.reference ?? null)
          : (event.data?.reference ?? null);

        if (metadata?.kind === 'addon') {
          const resourceType = metadata?.resourceType;
          const billingMode = metadata?.billingMode;
          const quantity = Number(metadata?.quantity ?? '0');
          return {
            eventId,
            type: 'checkout_completed',
            organizationId: metadata?.organizationId ?? null,
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

        const billingCycle = metadata?.billingCycle;
        return {
          eventId,
          type: 'checkout_completed',
          organizationId: metadata?.organizationId ?? null,
          externalSubscriptionId: event.data?.reference ?? null,
          currentPeriodEnd: null,
          planId: metadata?.planId ?? null,
          billingCycle: billingCycle === 'monthly' || billingCycle === 'quarterly' || billingCycle === 'yearly' ? billingCycle : null,
          kind: 'plan',
          amount: typeof event.data?.amount === 'number' ? event.data.amount / 100 : null,
          currency: event.data?.currency ? String(event.data.currency).toUpperCase() : null,
        };
      }
      case 'invoice.payment_failed':
        return {
          eventId,
          type: 'renewal_failed',
          organizationId: null,
          externalSubscriptionId: event.data?.subscription?.subscription_code ?? null,
          currentPeriodEnd: null,
          planId: null,
          billingCycle: null,
          kind: 'plan',
        };
      case 'subscription.not_renew':
      case 'subscription.disable':
        return {
          eventId,
          type: 'subscription_cancelled',
          organizationId: null,
          externalSubscriptionId: event.data?.subscription_code ?? null,
          currentPeriodEnd: null,
          planId: null,
          billingCycle: null,
          kind: 'plan',
        };
      default:
        return null;
    }
  }

  async cancelSubscription(externalSubscriptionId: string): Promise<void> {
    await this.request('/subscription/disable', {
      method: 'POST',
      body: JSON.stringify({ code: externalSubscriptionId, token: externalSubscriptionId }),
    });
  }
}
