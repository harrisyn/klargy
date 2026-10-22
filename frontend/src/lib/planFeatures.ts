// Names for the plan feature flags (SubscriptionPlan.features). Only keys the
// server enforces are listed; anything else is not shown. Used by the billing
// page and the public pricing page.
export const FEATURE_LABELS: Record<string, string> = {
  analytics: 'Analytics',
  ai: 'AI-assisted analytics',
  multiLocation: 'More than one location',
  servicePoints: 'Desks and rooms',
  serviceFlows: 'Journeys between services',
  smsNotifications: 'Text message alerts',
  whatsappNotifications: 'WhatsApp messages',
  ownPaymentKeys: 'Your own payment account for bookings',
  customBranding: 'Own logo and colour',
  customDomain: 'Custom domain',
  apiAccess: 'API and integrations',
  emrIntegration: 'Connected systems (CRM, POS, EMR)',
  displayMedia: 'Adverts on lobby screens',
  // legacy keys from the old plan editor
  multipleLocations: 'More than one location',
  whiteLabel: 'Own logo and colour',
};
