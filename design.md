# Secure Transfer interface

Release target: v0.5.0. The user requested a navy blue, scarlet red and white interface that works for clients with varied technical experience. This design covers client workflows and the enterprise administration extension of the existing application. Production infrastructure and commercial acceptance remain separate release gates.

## Design system

Modern, restrained product workspace. Navy provides navigation and hierarchy; white provides readable working surfaces; scarlet identifies the main send action and selected accents. Status labels always include words and icons, rather than relying on color. One consistent system covers sign-in, transfers, dialogs and workspace settings.

The app uses a workspace layout: persistent navigation on desktop, compact navigation on mobile, a functional page heading, a quiet usage summary and a searchable transfer list. Sign-in uses a split composition with a simple email form and a navy brand panel. The main app prioritizes real content over decoration.

Typography: locally hosted Instrument Sans regular/bold for body and controls; Bricolage Grotesque bold for the wordmark and introductory headings. OFL licenses accompany the fonts. No external font requests. The baseline is 16px, with 14px supporting labels and tabular numerals for file sizes and usage.

Color, spacing, type, radius and motion tokens live in `public/tokens.css`. Default surfaces are white and cool off-white; text and focus rings are navy. Primary scarlet must maintain at least 4.5:1 text contrast with white. Controls have visible focus rings and 44px touch targets. No decorative page-load animation; brief press feedback and dialog entry respect reduced motion.

## Information architecture

- Sign-in: email, verification code, change-email action, delivery feedback and local inbox link only when local mail capture is configured. Support paste and one-time-code autocomplete.
- Transfers: current workspace, clear send action, real usage/counts, All/Sent/Received filters, search and status filter. File rows show name, size, sender/recipient, readable status, expiry and permitted actions.
- Send dialog: one screen at a time, File → Recipient → Access → Review → Result. Include optional drag/drop, lossless compression choice, actual chunk progress, pause/resume and a recipient link with scan explanation. Back preserves input.
- Analytics: separate owner/admin screen with real 7/30/90-day UTC totals, accessible upload/download chart and expandable paginated daily data.
- Billing: separate owner/admin screen with actual subscription/limits, payment history and configured/off provider states. Owners choose plan/renewal then review terms and consent on separate compact screens. Stripe may recur or be prepaid; M-Pesa/crypto are prepaid. Prices/currency/credentials remain unconfigured.
- Platform: explicit server allowlist only, hidden from ordinary workspace owners. Search/paginate clients, review aggregate usage, edit guarded manual subscriptions or separately pause/reactivate access with a reason. Do not expose file plaintext or imply that access suspension cancels charges.
- Workspace settings: current members, explained roles, add/update/remove access, activity export and a clearly labeled billing simulator when enabled. Team creation is a dedicated dialog.
- Help: a short explanation of sending, checking and receiving files, plus the server-managed encryption boundary.
- Revocation/member removal: explicit confirmation explains the immediate access loss. These actions cannot offer a reliable Undo with the existing API.

## Interaction requirements

Every action has an accessible name and visible feedback. Forms preserve input on failure and show errors near the affected task. Dialogs contain focus, support Escape and restore focus. Expired sessions clear private state and invite sign-in again. Requests started in another workspace/session cannot render into the current workspace. Polling does not repeatedly rebuild unchanged rows or steal keyboard focus. A failed refresh keeps the last usable data visible with a retry action.

Use plain language: “Checking file”, “Ready to download”, “Expired”, “Blocked” and “Removed” instead of internal state names. The interface must distinguish empty results, no transfers, loading, service failure and upload failure. Counts describe loaded transfers, not unsupported lifetime analytics. Do not invent users, testimonials, file records or business metrics.

## Implementation boundaries

Retain the Express/MongoDB API, authorization rules, in-memory app sessions, scanning worker and storage adapters. Native download capabilities use a separate file-scoped HttpOnly cookie until file expiry, with explicit logout revocation, to support long resumable downloads. Expose only safe client configuration and tenant-scoped dashboard projections; platform routes require verified allowlisted identities. Add focused dashboard/payment/resumable modules and keep payment credentials server-side. Preserve the CSP; serve assets locally. No new production UI framework is required.

Modify the existing HTML/CSS/JavaScript in place; add reusable tokens, icons and font assets. Preserve all existing transfer and workspace capabilities. Leave the user's uncommitted skill-installation files untouched. Work on a feature branch and publish a PR; ask before merging to main. Commit messages have no assistant attribution.

## Acceptance evidence

Review real desktop and mobile screenshots at 320, 375, 414, 768 and 1440 CSS pixels. Check long names/email addresses, 200% text scaling, reduced motion and keyboard-only operation. Run automated axe checks without suppressing contrast rules on sign-in, workspace, send dialog and settings. Exercise real sign-in, workspace creation, member roles, clean-file scanning, recipient download, copy/share, search/filter, activity export, cancellation, revocation and sign-out. Repeat the live browser flow for filesystem and S3 storage in CI. Keep screenshots and accessibility reports as ignored local artifacts, and document the result honestly.
