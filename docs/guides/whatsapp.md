# WhatsApp notifications

Each organisation can send its patients' queue updates and appointment
reminders from **its own WhatsApp number**. WhatsApp is tried first for anyone
who gave a phone number and may be messaged there; a text message goes instead
when WhatsApp can't deliver, if the organisation chooses that. Patients still
see live updates on their ticket page as before.

Messages go out on the organisation's own WhatsApp account, so the provider
bills the organisation directly and Klargy's message credits aren't used. A
text message sent as a fallback uses SMS credits as usual.

## What gets sent

| Message | When | Template values usually needed |
|---|---|---|
| Joined the queue | A ticket is issued (kiosk, QR join page, staff, Connect) | name, ticket, service, status page link |
| Sent to another service | A ticket made by a transfer ("sent to") | name, ticket, service, status page link |
| Turn approaching | They're within the "tell them when they're this many places from the front" setting | ticket, place in line, service |
| Called | Staff call them | ticket, service, desk or room |
| Queue paused | Their queue is paused | service, the full message |
| Appointment reminder | About a day before an appointment | name, service, location, date, time |

Each is sent once per ticket (once per pause for "Queue paused").

## Before you start

- The plan needs **WhatsApp messages** (`whatsappNotifications`). In
  superadmin, edit the plan under **Plans** and tick it. Without it the
  WhatsApp section shows as locked and nothing is sent.
- `APP_URL` must be the public address of Klargy: providers post delivery
  receipts and replies to `APP_URL/api/v1/webhooks/whatsapp/<organisation id>`.
- `MASTER_ENCRYPTION_KEY` encrypts the credentials, like payment keys. Keep it
  the same across deploys.

There are no other platform settings: everything is per organisation, under
**Settings → WhatsApp**, by an organisation admin.

## Choose a provider

| | WhatsApp Cloud API (Meta) | Twilio | WhatsApp Web (linked phone) |
|---|---|---|---|
| What it is | Meta's official API on your WhatsApp Business number | A WhatsApp sender on your Twilio account | A self-hosted [go-whatsapp-web-multidevice](https://github.com/aldinokemal/go-whatsapp-web-multidevice) server with a phone linked to it (what Serenity uses) |
| Templates | Yes, approved by Meta | Yes, Twilio Content templates approved for WhatsApp | No: plain messages |
| 24-hour rule | Applies | Applies | Doesn't apply |
| Delivery receipts | Sent, delivered, read, failed | Queued, sent, delivered, read, failed | Delivered, read (if the server sends them) |
| Good for | Production | Teams already on Twilio | Pilots, small sites; not an official API, and WhatsApp may restrict numbers used this way |

### WhatsApp Cloud API

1. In Meta Business Suite, set up WhatsApp and a business phone number. From
   **WhatsApp Manager → API setup** copy the **Phone number ID** and the
   **WhatsApp Business Account ID**.
2. Create a **system user** with a permanent token that has
   `whatsapp_business_messaging` and `whatsapp_business_management`. That's the
   **Access token**.
3. From the Meta app's **Settings → Basic**, copy the **App secret**. Klargy
   uses it to check that webhooks really come from Meta.
4. In Klargy, **Settings → WhatsApp**, choose **WhatsApp Cloud API**, fill these
   in and **Save**.
5. Copy the **Callback URL** and **Verify token** shown under **Webhook** into
   the Meta app's **WhatsApp → Configuration → Webhook**, press *Verify and
   save*, then subscribe to the **messages** field.
6. Press **Test connection**. It shows the number's verified name and quality
   rating.

### Twilio

1. Register a WhatsApp sender in Twilio (or use the sandbox number to try it).
2. Enter the **Account SID**, the **Auth token** and either the **WhatsApp
   sender number** or a **Messaging Service SID**, and **Save**.
3. Klargy asks Twilio to post delivery receipts to the Callback URL on every
   message, so there's nothing to set for those. For replies (and STOP), set
   the Callback URL as the sender's **"When a message comes in"** webhook.
4. **Test connection** checks the account.

Twilio signs each webhook with your auth token; Klargy checks the signature
against the Callback URL exactly as shown, so use that URL unchanged.

### WhatsApp Web (linked phone)

1. Run go-whatsapp-web-multidevice somewhere Klargy can reach (HTTPS in
   production). Link the phone by scanning the QR code on the server's own
   page. If it is on a private network, set
   `ALLOW_PRIVATE_OUTBOUND_URLS=true` for Klargy.
2. Enter the **Server address**, the **Device ID** (`default` if you didn't set
   one) and, if the server uses `WHATSAPP_API_BASIC_AUTH_CREDENTIAL`, the same
   `username:password` as **Basic auth**. **Save**.
3. Klargy shows a **Webhook secret**. On the server set
   `WHATSAPP_WEBHOOK` to the Callback URL and `WHATSAPP_WEBHOOK_SECRET` to the
   secret, so replies and receipts come back signed.
4. **Test connection** checks the device is linked and connected.

## Templates and the 24-hour window

WhatsApp only lets a business start a conversation with a **template** it has
approved. Within 24 hours of a person writing to you, any message may be sent.
Klargy follows that rule for the Cloud API and Twilio:

- **They wrote to you in the last 24 hours:** the standard Klargy wording is
  sent as an ordinary message.
- **Otherwise:** the approved template mapped to that message type is sent,
  with its values filled in.
- **No usable template** (none mapped, or still pending, rejected or paused):
  WhatsApp isn't sent; a text goes instead if the fallback is on.

To set templates up:

1. Create them in WhatsApp Manager (or Twilio Content Template Builder) as
   **Utility** templates, with numbered values `{{1}}`, `{{2}}`… For example,
   *"Hi {{1}}, you're in the queue at Nyaho. Your ticket is {{2}} for {{3}}.
   Track your place: {{4}}"*.
2. Once approved, in Klargy press **Load templates**. Each message type gets a
   list of your templates with their status; pick one. Klargy suggests values
   for each `{{n}}`; change them to match your wording. With Twilio, picking
   from the list also fills in the Content SID (HX…).
3. **Save**. Load templates again any time to refresh their status: a template
   that is no longer approved shows as such and is skipped.

You can also type a template name and language by hand. Its status then shows
"Unknown" and it's tried as if approved.

"Sent to another service" uses the "Joined the queue" template when it has
none of its own.

## Who gets messages (consent)

- **Only people who opt in** (default, and what WhatsApp's policy expects):
  the join page shows *"Send me updates on WhatsApp"* under the phone number.
  People are also opted in when an EMR sends `whatsappOptIn: true` with the
  patient through Klargy Connect, or when they message your number START.
- **Anyone who gives a number**: the join page says updates come on WhatsApp
  and that STOP turns them off.

Replying **STOP** (or UNSUBSCRIBE, CANCEL, END, QUIT, OPT OUT) opts the
number out for your organisation and confirms it; **START** (or YES) opts back
in. Someone who opted out gets no WhatsApp messages and no text in their place.
The settings page shows how many numbers have opted in and out.

**Country code for local numbers** turns a number typed without one
(020 000 0000) into an international one (+233 20 000 0000).

## Text messages

- **"Send a text message instead when WhatsApp can't deliver"**: when WhatsApp
  isn't sent (no template outside the window, provider error) or a message
  later fails (the provider's receipt says *failed*), a text goes instead,
  once.
- With **"Text people who give a phone number"** on (Settings →
  Notifications), a text goes to anyone WhatsApp doesn't reach, fallback or
  not. When WhatsApp delivers, no text is sent for the same update.

## Checking it works

- **Test connection** checks the saved credentials with the provider; the
  result stays on the page.
- **Send a test message** sends a real message to a number: an ordinary
  message within the 24-hour window (or on a linked phone), otherwise the
  "Joined the queue" template with sample values (on the Cloud API, Meta's
  `hello_world` until you map one).
- Each WhatsApp message is stored as a notification with the provider's
  message id and its latest delivery status (queued, sent, delivered, read or
  failed, with the reason). Receipts arriving out of order never move a
  status back.

## Security

- Tokens, secrets and basic-auth passwords are encrypted at rest and never
  sent back to the browser (only the last four characters, masked).
- Every webhook is checked before it is read: Meta and WhatsApp Web by
  `X-Hub-Signature-256` (HMAC-SHA256 of the body with the app secret / webhook
  secret), Twilio by `X-Twilio-Signature`. Unsigned or wrongly signed calls get
  401. Meta's verification handshake needs the verify token.
- A WhatsApp Web server address must be a public address unless
  `ALLOW_PRIVATE_OUTBOUND_URLS=true`.

## Troubleshooting

| What you see | Why |
|---|---|
| "No approved template for …, and the 24-hour window is closed" on a notification | Map an approved template to that message type, or the person has to write to you first. |
| Meta error 131047 / Twilio 63016 | Free-form message outside the 24-hour window; same fix. |
| Test connection: "isn't linked" (WhatsApp Web) | Scan the QR code on the WhatsApp server again; check the Device ID. |
| Webhook calls get 401 | The app secret / auth token / webhook secret in Klargy doesn't match the provider's, or (Twilio) the URL configured differs from the Callback URL. |
| Nothing is sent and no notification row | WhatsApp is switched off, the plan lacks it, the number hasn't opted in (opt-in mode) or opted out. |
