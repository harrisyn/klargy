// WhatsApp channel: what the settings page shows and the server checks.
// Shared by the admin UI and the API so both agree on fields and keys.

export type WhatsAppProviderId = 'meta_cloud' | 'twilio' | 'whatsapp_web';

export interface WhatsAppField {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  hint?: string;
}

export interface WhatsAppProviderSpec {
  id: WhatsAppProviderId;
  label: string;
  note: string;
  /** Plain settings, shown back to the admin. */
  fields: WhatsAppField[];
  /** Encrypted at rest, only ever shown masked. */
  secrets: WhatsAppField[];
  /** Business API providers only send pre-approved templates outside the
   * 24-hour window after a person last wrote. A linked phone has no such rule. */
  templates: boolean;
}

export const WHATSAPP_PROVIDERS: WhatsAppProviderSpec[] = [
  {
    id: 'meta_cloud',
    label: 'WhatsApp Cloud API',
    note: 'Meta’s official API. Your own WhatsApp Business number, approved templates and delivery receipts.',
    fields: [
      { key: 'phoneNumberId', label: 'Phone number ID', required: true, placeholder: '106540352242922', hint: 'WhatsApp Manager → API setup.' },
      { key: 'businessAccountId', label: 'WhatsApp Business Account ID', placeholder: '102290129340398', hint: 'Needed to load your templates.' },
      { key: 'apiVersion', label: 'Graph API version', placeholder: 'v21.0' },
    ],
    secrets: [
      { key: 'accessToken', label: 'Access token', required: true, hint: 'A permanent system-user token with whatsapp_business_messaging.' },
      { key: 'appSecret', label: 'App secret', required: true, hint: 'Checks that webhooks really come from Meta.' },
    ],
    templates: true,
  },
  {
    id: 'twilio',
    label: 'Twilio',
    note: 'A WhatsApp sender on your Twilio account. Templates are Twilio Content templates approved for WhatsApp.',
    fields: [
      { key: 'accountSid', label: 'Account SID', required: true, placeholder: 'AC…' },
      { key: 'from', label: 'WhatsApp sender number', placeholder: '+14155238886', hint: 'Or leave blank and use a Messaging Service.' },
      { key: 'messagingServiceSid', label: 'Messaging Service SID', placeholder: 'MG…' },
    ],
    secrets: [{ key: 'authToken', label: 'Auth token', required: true, hint: 'Also checks that webhooks really come from Twilio.' }],
    templates: true,
  },
  {
    id: 'whatsapp_web',
    label: 'WhatsApp Web (linked phone)',
    note: 'A self-hosted go-whatsapp-web-multidevice server with a phone linked to it. Plain messages, no templates.',
    fields: [
      { key: 'baseUrl', label: 'Server address', required: true, placeholder: 'https://wa.yourclinic.com' },
      { key: 'deviceId', label: 'Device ID', placeholder: 'default' },
    ],
    secrets: [{ key: 'basicAuth', label: 'Basic auth', placeholder: 'username:password', hint: 'Only if the server asks for it (WHATSAPP_API_BASIC_AUTH_CREDENTIAL).' }],
    templates: false,
  },
];

export const providerSpec = (id: string) => WHATSAPP_PROVIDERS.find((p) => p.id === id);

/** Messages Klargy sends, each with its own template. */
export const WHATSAPP_TEMPLATE_KEYS = [
  'QUEUE_JOINED',
  'QUEUE_TRANSFERRED',
  'TURN_APPROACHING',
  'NOW_SERVING',
  'QUEUE_DELAYED',
  'APPOINTMENT_REMINDER',
] as const;
export type WhatsAppTemplateKey = (typeof WHATSAPP_TEMPLATE_KEYS)[number];

export const WHATSAPP_TEMPLATE_INFO: Record<WhatsAppTemplateKey, { label: string; example: string; suggested: string[] }> = {
  QUEUE_JOINED: { label: 'Joined the queue', example: 'Your ticket for {{service}} is {{ticket}}…', suggested: ['name', 'ticket', 'service', 'statusUrl'] },
  QUEUE_TRANSFERRED: { label: 'Sent to another service', example: 'You’ve been sent to {{service}}. Your new ticket is {{ticket}}…', suggested: ['name', 'ticket', 'service', 'statusUrl'] },
  TURN_APPROACHING: { label: 'Turn approaching', example: 'You’re number {{position}} in line for {{service}}…', suggested: ['ticket', 'position', 'service'] },
  NOW_SERVING: { label: 'Called', example: 'It’s your turn for {{service}}. Please go to {{servicePoint}}.', suggested: ['ticket', 'service', 'servicePoint'] },
  QUEUE_DELAYED: { label: 'Queue paused', example: '{{service}} is paused for now…', suggested: ['service', 'message'] },
  APPOINTMENT_REMINDER: { label: 'Appointment reminder', example: 'Your {{service}} appointment at {{location}} is on {{date}} at {{time}}.', suggested: ['name', 'service', 'location', 'date', 'time'] },
};

/** Values a template parameter can be filled with. */
export const WHATSAPP_VARIABLES: Record<string, string> = {
  name: 'First name',
  org: 'Organization name',
  ticket: 'Ticket number',
  service: 'Service',
  position: 'Place in line',
  servicePoint: 'Desk or room',
  statusUrl: 'Status page link',
  location: 'Location',
  date: 'Appointment date',
  time: 'Appointment time',
  message: 'The full standard message',
};

export type WhatsAppDeliveryStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface WhatsAppTemplateMapping {
  name: string;
  language: string;
  /** As last reported by the provider: APPROVED, PENDING, REJECTED, PAUSED… UNKNOWN when typed in by hand. */
  status?: string;
  /** Template parameters {{1}}, {{2}}… in order, each a key of WHATSAPP_VARIABLES. */
  variables: string[];
  /** Twilio Content template SID (HX…). */
  contentSid?: string;
  category?: string;
}
