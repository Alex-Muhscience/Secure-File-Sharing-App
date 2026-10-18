# Secure Transfer

Secure Transfer is a web application for **sharing files with verified recipients, compressing files without losing data, and managing those workflows in personal or team workspaces**. It includes client usage/billing screens and a separate platform administration dashboard.

**Current release: v0.6.0 — a working local pilot, with production acceptance still outstanding.** The application and compression upgrade are merged into `main` through [PR #8](https://github.com/Alex-Muhscience/Secure-File-Sharing-App/pull/8). Secure Transfer is the working product name; final branding is undecided.

## What you can do today

| Workflow | Built behavior |
| --- | --- |
| Send a file | Upload, inspect, store encrypted content and share an access link. The recipient verifies their email before downloading. |
| Compress and download | Choose a file category and compression preference, then download a `.stc` or standard `.gz` archive or the exact original. No recipient is required. |
| Compress and send | Use the compression workflow with a recipient and a verified-access link. Email carries the link, not a file attachment. |
| Restore an archive | Upload a Secure Transfer `.stc` archive, reconstruct and inspect the original, then download it. Standard `.gz` files use ordinary gzip tools. |
| Work with a team | Create workspaces, assign owner/admin/member/viewer roles, enforce quotas and revoke access. |
| Review client activity | Workspace owners/admins see usage analytics, storage, subscription limits, payment history and billing-provider status. |
| Operate the platform | Explicitly allowlisted operators manage client workspaces, manual subscriptions, access suspension and aggregate analytics. |

The navy, scarlet and white interface uses focused steps instead of a long form. Six categories cover documents/office files, structured data, developer files, images, audio/video and archives/other files. Industry selections provide guidance; processing preserves original bytes. Image resizing, video transcoding and lossy conversion are not part of these workflows.

## Read this before evaluating the product

- **File size:** the default accepted file size is **10 MiB**. Configuration supports a ceiling of **5 TiB**, but actual 1–5 TB uploads, inspection and recovery have not been validated. Upload, scanner and workspace quotas all apply.
- **Compression:** 75% reduction is a measured per-file target, not a guarantee. The best tested settings meet it on **5 of 8 nonempty synthetic fixtures**. Our custom STP1 codec reaches **86.96% on a separate correlated-data probe**, and loses on the general fixture set. See the [measurements and target misses](docs/benchmarks/2026-10-18-summary.md).
- **Speed:** controlled WAN tests show benefits on compressible files, while some LAN/tiny-file cases regress. The new workflow is opt-in; existing quick-send defaults remain. Real client-device and network performance is unvalidated.
- **Encryption:** stored files use server-managed authenticated encryption. Authorized server operators can decrypt; this is not end-to-end encryption. Downloaded `.stc`/`.gz` archives are **not encrypted**. No claim of world-leading encryption or compression is established.
- **Payments and email:** Stripe, M-Pesa and optional BitPay integration code exists, but checkout defaults off and merchant acceptance is unfinished. Local Mailpit captures messages; it does not deliver them externally.

[Delivery status and remaining work](docs/DELIVERY_STATUS.md) is the current source for readiness, evidence and priorities. A working feature, a passing fixture and production acceptance are different milestones.

## Run locally

Use Node **24.19+ in the 24.x line** and Docker Compose. The tested release runtime is Node 24.21.0. ClamAV has a 2 GiB container memory limit; allow additional memory for the app, worker, MongoDB and Docker. The following commands start a new filesystem installation.

```bash
node scripts/init-local.cjs
docker compose --env-file /dev/null -f compose.app.yaml up -d --build --wait
```

Open **http://localhost:3081** and the local email inbox at **http://localhost:8025**. Verify your email and choose a workspace. New installations have no platform administrator until one is configured explicitly.

This existing development workspace additionally uses **http://secure-transfer.localhost:3081**, the allowlisted email `admin@secure-transfer.localhost`, and private Garage S3 storage. Those are ignored local settings, not credentials or administrator access shipped to every clone. See [administrator setup and operator procedures](docs/OPERATIONS.md#enterprise-workspace-operations-v050).

**Updating an existing installation:** preserve its environment files, keys, volumes and configured storage mode. If it uses S3 or retains S3 objects, keep the overlay:

```bash
docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml up -d --build --wait
```

For first-time S3 setup, migration, backup or rollback, follow [operations](docs/OPERATIONS.md). Initializers preserve existing credentials; recreating volumes or losing keys can make stored content unrecoverable. The working application uses `compose.app.yaml`, optionally with `compose.s3.yaml`. `compose.local.yaml` is an interface-only preview at port 3080; the legacy `docker-compose.yml` is not the current runbook.

## Where to find reliable information

| Question | Canonical document |
| --- | --- |
| What is built, what is limited, and what remains? | [Delivery status and priorities](docs/DELIVERY_STATUS.md) |
| How does it work, and where is the code/API? | [Implementation and repository map](docs/IMPLEMENTATION.md) |
| How do I configure, test, back up or recover it? | [Local pilot operations](docs/OPERATIONS.md) |
| How do the client screens and roles behave? | [Interface reference](design.md) |
| What do the codecs/archives do, and how do I restore offline? | [Compression formats and CLI](docs/COMPRESSION.md) |
| What is required for very large files? | [Large-file limits and validation](docs/LARGE_FILES.md) |
| What is implemented or still required for payments? | [Billing configuration and operations](docs/BILLING.md) |
| What actually happened in earlier releases? | [Release history and evidence index](docs/IMPLEMENTATION.md#release-history-and-evidence) |

Historical audits and implementation plans preserve earlier findings and intent. They are labeled as historical and do not override the current status document, source code or test evidence. No single percentage describes project completion.

## API

The [API reference and authentication lifecycle](docs/IMPLEMENTATION.md#api) live with the implementation map. Requests use a bearer session and the selected workspace; native attachment grants are scoped separately to a file and representation. Workspace selection never overrides authorization.

## Contributing and verification

Use a branch and pull request, update the document that owns each changed fact, and ask the repository owner before merging. Keep secrets, customer files, generated exports, browser artifacts and local skill installations out of application commits. Commit messages contain no assistant attribution. Documentation-only changes do not establish new product capabilities or require a product version bump.

GitHub automatically deletes source branches after an approved merge. Update and verify local `main`, then remove the corresponding merged local branch as well.

Start with [the verification runbook](docs/OPERATIONS.md#verification). The release workflow checks syntax, tracked secrets, dependencies, unit/integration suites, UI/races, packaged filesystem/S3 flows and encrypted backups. The [main merge checks](https://github.com/Alex-Muhscience/Secure-File-Sharing-App/actions/runs/39072849467) passed for v0.6.0; that evidence does not replace the remaining production and customer acceptance work.
