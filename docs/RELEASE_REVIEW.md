# v0.5.0 release review and decisions

A fresh whole-branch review examined `cc87ad9..e6c380d` against the interface specification, enterprise implementation plan, and documented local-pilot boundaries. It found five Important issues and one initially Minor issue. The executor treated stale action effects as Important because they can affect another workspace and block a reused control. All six entered one regression-tested correction pass; no findings were deferred.

| Finding | Correction | Regression evidence |
| --- | --- | --- |
| Obsolete subscription replaces newer access | Persist order/entitlement generation and current-subscription binding; record historical invoices separately | `test/payment-ordering.cjs`: delayed canceled subscription after prepaid/replacement recurring access, plus held reconciliation racing a prepaid grant; failed before correction, passes after |
| Local expiry allows duplicate recurring obligations | Block replacement until provider-confirmed canceled/incomplete-expired status; application access expiry is insufficient | `test/payment-ordering.cjs`: expired local access cannot start another external checkout; failed before, passes after |
| Logout loses download handoff race | Insert grant, then recheck originating live session before exposing cookie; delete/reject on logout | `test/resumable.cjs`: logout between ticket authentication and grant creation; failed before, passes after |
| Sandbox overwrites paid/operator state | Atomic subscription/generation/suspension predicates; manual changes advance generation | `test/authorization.cjs`: concurrent paid grant and operator pause; both failed before, pass after |
| Superseded verification installs old identity | Invalidate authentication generations when changing email/signing out and reject superseded responses | `test/ui-races.js`: delayed verification followed by changing email; failed before, passes after |
| Stale action errors/control restoration affect new context | Bind busy actions to context/action identity and reset controls when context changes | `test/ui-races.js`: new workspace reuses audit control while old action fails; original committed script reproduces failure, corrected script passes |

The full local suite after correction includes 10 core tests, 17 integration tests in 13 Mongo/private-S3 suites, and UI/axe plus browser race checks. Packaged filesystem/S3 browser, ClamAV/Mailpit, snapshot/restart and remote CI checks form the final release gate. A local database restart during restore tests was traced to MongoDB's 1,024 file-descriptor default (`TooManyFilesOpen`); Compose/CI now set 64,000. Volumes are preserved.

## Decisions and the review's stated boundaries

- Native download capabilities can outlive the one-hour app session until file expiry, at most seven days, while app tokens remain in memory. This permits multi-hour resume; the cost is retained file-only browser access. Explicit logout/current permissions still revoke it.
- Keep the local pilot limit at 10 MiB and describe 5 TiB as an unvalidated configuration target. No capable terabyte inspector/infrastructure was supplied; actual target-scale trials remain launch work.
- Actual 1–5 TB capacity/concurrent production performance remains unverified. Accept the bounded implementation and fixture evidence for this pilot; the cost is further provisioned load/recovery testing before commercial capacity claims.
- Live merchant settlement/provider acceptance, refunds/disputes and ambiguous-order repair remain launch gates. No credentials/prices were supplied; the cost is merchant sandbox and operational acceptance before enabling checkout.
- Independent cryptographic assurance and production key-service deployment remain external gates. Server-managed AEAD/secretstream is implemented; the cost is further review/infrastructure before making external security assurances.
- Ordinary session expiry does not itself revoke file-only download grants; this is the scoped-resume decision above, not permission to bypass explicit logout. The cost is the documented retained capability until file expiry.
- Sampled file fingerprints remain a selection hint during resume, requiring the unmodified original. Chunk checksums protect transmission, but the cost is no full local-file identity proof when a user deliberately or accidentally changes a same-metadata middle segment.
- Non-Chromium download managers and human usability/accessibility are not validated by the current automated evidence. Chromium/reflow/axe/visual checks passed; the cost is additional client/browser acceptance before broad rollout.

No merge to main is authorized by these checks. The enterprise foundation was already merged through PR #6. The repository owner must approve the correction PR #7 separately.
