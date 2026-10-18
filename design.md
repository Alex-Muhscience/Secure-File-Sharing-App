# Secure Transfer interface reference

Current implementation: **v0.6.0**, reconciled on **2026-10-18**. This describes the client/operator experience already built, including the enterprise screens and compression upgrade. It is not a second roadmap. [Delivery status](docs/DELIVERY_STATUS.md) owns remaining work; [implementation](docs/IMPLEMENTATION.md) maps the source/API.

## Design system and navigation

Navy establishes navigation and hierarchy, white provides readable working surfaces, and scarlet marks primary actions and selected accents. Status labels include words rather than relying only on color. Current tokens are in [public/tokens.css](public/tokens.css); shared styles/icons and locally hosted Instrument Sans/Bricolage Grotesque assets live under `public/` with their font licenses.

Desktop uses persistent workspace navigation; narrow layouts use compact navigation. The main experience separates Transfers, Analytics, Billing and Workspace settings. Explicit platform operators receive a separate Platform area with Clients and Analytics views. Permission checks happen on the server; hiding a control is not an authorization boundary.

The interface aims for visible keyboard focus, contained/restored dialog focus, readable labels, touch-sized controls, reduced-motion support and reflow. Automated axe/keyboard/200%-text checks provide evidence for tested screens, not complete human accessibility or every-browser acceptance.

## Client tasks and screens

| Task | Screen sequence | Completion behavior |
| --- | --- | --- |
| Sign in | Email → Verification code | Preserve errors/input, support paste/autocomplete and change-email; local inbox link appears only for configured local capture |
| Quick send | File → Recipient → Access → Review → Result | Scan before availability, expose recipient link and exact original download |
| Compress and download | Action → File type/industry → File → Options → Review → Result | No recipient; choose STC/gzip or exact original after inspection |
| Compress and send | Action → File type/industry → File → Options/recipient → Review → Result | Persist format/recipient, then show a verified-access link; email contains a link, not an attachment |
| Restore | Action → STC archive → Review → Result | Validate/reconstruct, reserve output space and inspect the original before download |
| Choose billing | Plan/renewal → Terms and consent → Provider/status | Show only configured prices/providers; no fabricated charges or successful-payment state |

File categories are documents/office files, structured data, developer files, images, audio/video and archives/other. Industry guidance covers general business, finance/legal, healthcare/research, engineering/data, creative/media and education. The labels do not change file bytes, perform lossy conversion or establish certification. A detected magic-header mismatch warns the user; it does not bypass decoder, quota or scanner policy.

Compression choices are Fast transfer, Smallest archive, custom-engine comparison and original storage. Custom comparison evaluates STP1 alongside established codecs. Selection is not a promise of a particular ratio or speed. The result distinguishes original size, encrypted storage, received upload payload and measured complete archive size. The 75% target is met/not met/not measured; empty originals have no percentage. Downloaded archives are unencrypted, which the interface explains.

Back preserves entries **before** saving a session. After a job is saved, its action/recipient/settings remain fixed through retries. Polling failure or a lost completion response must continue the same job; users close and start a new job to change it. Pause/resume requires the same unmodified original. Closing or switching workspace/session invalidates stale requests and polling. Reopening a job, including as an authorized recipient, keeps the saved STC/gzip representation.

## Workspaces, reporting and administration

- Transfers offers All/Sent/Received filters, search, status, permitted file actions, progress and revocation. Counts describe the loaded data rather than an invented lifetime total.
- Workspace owners/admins see real 7/30/90-day UTC analytics, storage and separate original-download/archive-export activity. Tables accompany charts; request/range counts do not prove completed receipt.
- Billing shows actual subscription/limits, order/payment history and provider status. Owners can start configured checkout or use the provider portal. Stripe supports recurring/prepaid; M-Pesa/crypto are prepaid. Live merchant acceptance is outstanding.
- Workspace settings manages members/roles and activity export. The local billing simulator is labeled separately; it cannot override paid/provider or operator-suspension state.
- Platform access requires the exact server-side email allowlist plus verification. Clients/Analytics are separate views. Operators inspect metadata/aggregate usage, change guarded manual plans or independently suspend access with a reason. This dashboard does not expose file plaintext. Suspending access does not cancel provider charges.
- Help explains transfer inspection, recipients, server-managed storage encryption and limits using plain language.

## Failure, confirmation and validation behavior

Use “Checking file”, “Ready to download”, “Expired”, “Blocked” and “Removed” rather than internal state names. Distinguish empty results, loading, service failure, upload failure and quarantine. Keep usable content on failed refresh and provide retry feedback near the task. A clean scan is not a guarantee that a file is harmless.

Dialogs support keyboard use and restore focus. Explicit revocation/member removal explains immediate access loss. Session expiry clears private app state and prompts sign-in. A file-only native grant can outlive app-session expiry for resumable downloads, but explicit logout and current access checks revoke it. Failed actions from an old context cannot change a new screen, restore the wrong control or attach an old recipient/job result.

Evidence lives in [UI checks](test/ui-browser.js), [race checks](test/ui-races.js), [packaged browser flows](test/browser.js) and [compression browser flows](test/compression-browser.js). The latter covers all six category choices, Back preservation, format mismatch, compressed download/send, target misses, exact inspected restore and native gzip reopening. Screenshots/reports are ignored local/CI artifacts. Human usability/accessibility and other-browser acceptance remain in [delivery status](docs/DELIVERY_STATUS.md).
