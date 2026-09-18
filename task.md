# Netra — Hackathon Task Checklist

**Hackathon target:** AWS First Commit — Ship It + Best UI

**Status legend:** `[x]` complete and verified · `[~]` in progress or blocked · `[ ]` not started

> A task is `[x]` only when it has been *run and observed working*, not merely when
> code for it exists. Where a claim rests on a specific observation, the evidence
> is noted inline.

---

## Status summary

**Current architecture**

```
GitHub → API Gateway → Lambda (webhook) → DynamoDB (delivery claim)
       → EventBridge → Step Functions → ECS/Fargate investigation task
       → deterministic analyzers (+ optional OpenRouter interpretation)
       → DynamoDB → [UI: local only today]
```

**Current verified milestone**
A genuine archived `Netra.CodeChange` event replayed through the deployed AWS
pipeline and completed: Step Functions started, a Fargate task cloned the real
repository, the investigation lifecycle ran `CREATED → … → RESOLVED`, and the
result persisted to DynamoDB. The commit was a README change, so it correctly
ended at `NoFindingToApprove`.

**Current critical path**
Credential-exposure fixture → `AWAITING_APPROVAL` on AWS → wire the existing UI
to AWS → remediation PR → post-fix verification → demo video.

**Current blockers**
- OpenRouter secret in AWS Secrets Manager is unpopulated, so no AI-backed
  investigation has run *on AWS* (it has run locally).
- The web UI talks to the local API only; nothing serves it from AWS yet.
- GitHub PR creation is not implemented anywhere.

**Stretch (explicitly out of MVP scope)**
Permission-boundary analysis, Cognito in production, Amplify hosting, S3
artifact storage, additional finding categories.

---

## 0. Project foundation

- [x] pnpm/TypeScript monorepo with shared `@netra/domain`
- [x] Investigation lifecycle state machine, single source of truth
      — `packages/domain/src/status.ts`, reused by the API, orchestrator and UI
- [x] Lifecycle forbids bypassing approval
      — no transition reaches `REMEDIATING` except via `AWAITING_APPROVAL`
- [x] Typecheck, lint and test scripts across all packages
- [x] `.gitignore` covers `.env`, `*.pem`, and local secret files
- [ ] Remove empty scaffold directories (`packages/analyzers`, `services/sandbox`,
      `docs`, `tests` contain no files)

## 1. GitHub App

- [x] GitHub App "Netra Security" created (App ID `4992979`, slug `netra-security`)
- [x] Least-privilege permissions: Metadata read, Contents read/write,
      Pull requests read/write
- [x] Subscribed to `push` and `pull_request` only
- [x] Installed on `Nakshatra480/Netra` (repository selection: *selected*)
- [x] App private key stored in Secrets Manager `netra/prod/github/app`
      — never in source control; verified by minting an App JWT and calling
      `GET /app`, which returned the expected permissions and events
- [x] Installation token minting verified
      — installation `162823444`, token issued and scoped to one repository

## 2. Webhook ingestion

- [x] Lambda webhook receiver behind API Gateway (`POST /github/webhook`)
- [x] HMAC SHA-256 signature verification, constant-time comparison
- [x] Legacy `sha1` scheme refused
- [x] Unsigned, forged and tampered deliveries rejected with 401
      — verified against the live endpoint
- [x] Unhandled event types acknowledged with 200 rather than retried
- [x] `ping` answered so the App can verify the endpoint
      — live delivery log shows `ping HTTP 200`
- [x] Secret read from Secrets Manager at runtime with a short cache
- [x] Fast acknowledgement (live deliveries returned in 0.66–0.79 s)

## 3. EventBridge

- [x] Custom bus `netra-prod`
- [x] `push` and `pull_request` normalised into one `Netra.CodeChange` event
- [x] Event published with source `netra.github`
- [x] Event archive `netra-prod-changes` (7-day retention) for replay
- [x] Rule `netra-prod-code-change` targets the state machine, `ENABLED`
- [x] Dead-letter queue for undeliverable events
- [x] Verified: `MatchedEvents` for `Source=netra.github` = 3 after 3 publishes

## 4. Delivery idempotency

- [x] DynamoDB table `netra-prod-deliveries` keyed on GitHub delivery id, TTL 7 days
- [x] Conditional write decides the winner, so concurrent invocations cannot both proceed
- [x] Claim taken *before* publishing
- [x] Claim released if publishing fails, so a retry is not mistaken for a duplicate
- [x] Failures refuse the delivery (500) rather than acknowledging it
- [x] **Proven end to end**: same GitHub delivery GUID
      `56d450a0-b392-11f1-9382-6535715b1e04` returned `202` on first delivery and
      `200 duplicate` on redelivery; three publishes for four deliveries
- [x] Second idempotency layer in the workflow: investigation id derived
      deterministically from the delivery id, created with a conditional write

## 5. Step Functions

- [x] State machine `netra-prod-investigation` deployed, `ACTIVE`, STANDARD
- [x] Lifecycle: `CreateInvestigation → AlreadyInvestigated? → RunInvestigation →
      ConfirmOutcome → ReachedApproval? → AwaitingApproval | NoFindingToApprove`
- [x] Duplicate gate short-circuits replayed events
      — three archived events stopped at `DuplicateIgnored`
- [x] Retries distinguish transient faults from permanent ones; a malformed event
      is rejected rather than replayed
- [x] Every failure path records a readable reason, so an investigation is never
      silently stuck
- [x] Success decided by the stored record, not by the task exiting zero
- [x] `AWAITING_APPROVAL` is terminal for this milestone — the workflow has no
      remediation state
- [x] Execution logging to CloudWatch with execution data excluded

## 6. ECS/Fargate investigator

- [x] ECR repository `netra/investigator`; ARM64 image pushed (~97 MB)
- [x] Cluster `netra-prod` `ACTIVE`
- [x] Task definition `netra-prod-investigator`: FARGATE, ARM64, 1024 CPU, 2048 MB
- [x] Task clones the repository with a GitHub App installation token
- [x] Task runs the full investigation lifecycle and persists results
- [x] **Verified on AWS**: task cloned `Nakshatra480/Netra` at `3822663130de`,
      ran `CREATED → PREPARING → INVESTIGATING → EVIDENCE_COLLECTION → VERIFYING →
      IMPACT_ANALYSIS → RECOMMENDATION → RESOLVED`, wrote 43 events and a graph
- [~] Only the no-finding path has run on AWS; the finding path has not

## 7. Sandbox / security

- [x] Explicit command allowlist: four binaries (`git`, `rg`, `cat`, `find`)
- [x] The model emits a tool name and typed arguments, never a command
- [x] Unknown tool names and rejected arguments execute nothing
- [x] Path traversal, flag smuggling and shell metacharacters refused
- [x] `SandboxExecutor` abstraction: `DockerSandbox` locally, `TaskSandbox` on Fargate
- [x] Local Docker sandbox verified by executing real containers: non-root,
      no routable address or route, read-only mounts, no Docker socket, no
      privilege escalation
- [x] Fargate boundary documented and tested: ephemeral task, non-root,
      no nested containers, minimal IAM, destroyed after the investigation
- [x] Analyzer parity test — both boundaries reach the same verdict
- [x] Netra's own credentials stripped from the analysis process environment
- [x] Clone token passed via git askpass, never embedded in the remote URL
      (a URL-embedded credential persists in `.git/config`, which the analyzer reads)
- [x] Investigator container has no Secrets Manager permission; the ECS agent
      injects its secrets

## 8. Deterministic analysis

- [x] Credential-exposure / unsafe-secret-flow analyzer (`secret-flow-v1`)
- [x] Diff-first: finds secret-named identifiers the change *added*
- [x] Browser surface derived from the project's own bundler config, not convention
- [x] Import-graph reachability from browser entry points
- [x] Reports a finding only when a concrete path is traced
- [x] Verified against the fixture: traces the exposure on the risky commit and
      stays silent on the safe baseline
- [x] Deterministic verification is authoritative; only code may set `VERIFIED`

## 9. OpenRouter AI

- [x] Provider-agnostic `ModelProvider` interface; no Bedrock, no Strands
- [x] `OpenRouterProvider` with a multi-key reliability failover pool
      (rate-limit backoff, exhaustion retirement, no quota evasion)
- [x] `OllamaProvider` for local fallback; reports honestly when no capable
      local model is installed
- [x] `ModelRouter`: OpenRouter → Ollama → deterministic-only, never loops
- [x] Server-side model allowlist with DEEP/STANDARD/FAST tiers
- [x] Token optimizer: deterministic prefilter, context deduplication,
      summarisation, hard turn/token/cost budgets
- [x] Usage and provenance recorded without credentials
- [x] **Verified locally**: OpenRouter · Claude Sonnet 4.5, 1 turn,
      203 context tokens, $0.0052, full loop to `RESOLVED`
- [~] **Not verified on AWS** — `netra/prod/model/openrouter` has no value, so
      the deployed task runs deterministic-only
- [ ] Populate the AWS secret and redeploy with `ModelSecretPopulated=true`
- [ ] Run an AI-backed investigation on AWS and confirm the interpretation is
      attached to evidence rather than replacing verification

## 10. Investigation data model

- [x] Typed domain model: investigation, finding, evidence, verification,
      blast radius, action, audit event, model provenance
- [x] DynamoDB `netra-prod-investigations`, PAY_PER_REQUEST, one partition per
      investigation (`pk=INV#<id>`, `sk=META|EVENT#|FINDING#|EVIDENCE#|VERIFY#|GRAPH`)
- [x] Lifecycle events persisted as they happen, so a dying investigation still
      shows how far it got
- [x] Model chain-of-thought never stored — only declared fields survive parsing
- [ ] S3 for large artifacts (not needed at current payload sizes)

## 11. Credential-exposure finding

- [x] Finding model: category, severity, subject, affected files, confidence,
      verification status, recommendation, remediation availability
- [x] Severity ranked by credential sensitivity, so the headline names the worst one
- [x] Demo fixture: real two-commit git repository whose second commit routes
      AWS credentials into a browser bundle (`demo/vulnerable-repo`)
- [x] Verified locally: CRITICAL finding, 9 evidence items, VERIFIED
- [ ] **Fixture driven through the real AWS path to `AWAITING_APPROVAL`** ← critical path

## 12. Evidence + verification

- [x] Evidence carries file, line, snippet, relationship, the analyzer that
      produced it and the command whose output contained it
- [x] Verification records claim, detail, verifier, duration and phase
      (`PRE_FIX` / `POST_FIX`)
- [x] Confidence derived from verification status, never chosen by a model
- [x] UI distinguishes "model hypothesis" from "verified by deterministic check"
- [x] Verified locally: `PRE_FIX VERIFIED` → `POST_FIX REFUTED`

## 13. Blast radius

- [x] Graph built from traced facts: changed files, imports, secrets, bundler,
      external surface, finding
- [x] Nodes carry the evidence ids that justify them
- [x] Affected path marked distinctly
- [x] Accessible prose summary alongside the graph
- [x] React Flow visualisation with filter, selection and evidence linking
- [x] Verified locally: 9 nodes, 11 edges, 8 on the affected path
- [ ] Rendered from AWS-persisted data (currently local API only)

## 14. Human approval

- [x] Approval boundary enforced structurally in the lifecycle
- [x] Approval panel shows finding, reason, evidence count, affected files,
      exact diff, expected impact and verification status
- [x] Approver identity taken from the verified token, never the request body
- [x] Reject path with a recorded reason
- [x] Verified locally: approval drove remediation and the action recorded
      `EXECUTED` with the approver's id
- [ ] Approval available against the AWS pipeline

## 15. GitHub remediation PR

- [x] Remediation patch computed deterministically, not written by a model
- [x] Patch bounded to files on the traced exposure path; the rest of the change
      is untouched
- [x] `git apply` refuses anything that is not the approved diff
- [x] Applied to a branch and committed locally, with the approver recorded
- [ ] **Push the branch and open a pull request via the GitHub App** — not
      implemented anywhere in the repository
- [ ] Record the PR URL on the action

## 16. Post-fix verification

- [x] Same analyzer re-run against the remediated commit
- [x] `RESOLVED` means the check that proved the problem can no longer find it
- [x] Verified locally: `POST_FIX REFUTED` → `RESOLVED`
- [ ] Post-fix verification on AWS

## 17. Frontend / UI

- [x] React + TypeScript + Tailwind + React Flow + xterm.js + Framer Motion + Lucide
- [x] Dark-first, semantic colour system; red reserved for proven severity
- [x] Landing page, sign-in, Command Center, Investigation page
- [x] Investigation page: header, plain-English summary, blast radius, evidence,
      terminal, approval, AI provenance bar
- [x] Loading, empty, error and failure states; reduced-motion honoured
- [x] Sections that are not built say so rather than showing invented data
- [~] **Runs against the local API only** (`VITE_API_BASE_URL`, default
      `http://localhost:8787`); not wired to the deployed AWS pipeline
- [ ] Read investigations from the AWS API
- [ ] Deploy the frontend (no hosting resource exists in IaC)

## 18. Live terminal / telemetry

- [x] xterm.js terminal renders real command events: argv, stdout, stderr,
      exit code, duration
- [x] Structured events: `command_started`, `command_output`, `command_finished`,
      `finding_detected`, `evidence_found`, `verification`, `graph_updated`
- [x] Concise activity summaries; no chain-of-thought exposed
- [x] SSE streaming with replay-by-sequence on reconnect (local API)
- [x] Events persisted from the Fargate task to DynamoDB
- [ ] Stream AWS-persisted events to the UI

## 19. Authentication / workspace

- [x] Cognito access-token verification in the API (`aws-jwt-verify`)
- [x] Browser sign-up / sign-in / sign-out via `amazon-cognito-identity-js`
- [x] Identity always derived from verified claims; client-supplied `ownerId` ignored
- [x] Idempotent workspace provisioning per verified identity
- [x] Demo sessions are server-signed and cannot be forged
- [ ] **No Cognito user pool exists in IaC or in AWS** — real sign-in is
      unavailable in production; demo mode is the only working path

## 20. Production deployment

- [x] SAM template, reproducible; no hardcoded account ids or secrets
- [x] Stack `netra-prod` deployed, `UPDATE_COMPLETE`
- [x] API Gateway + webhook Lambda live
- [x] DynamoDB ×2, EventBridge bus + rule + archive, SQS DLQ
- [x] Step Functions, ECS cluster, Fargate task definition, ECR image
- [x] Secrets Manager: webhook secret (generated by AWS), GitHub App credentials
- [x] Five workflow IAM roles created out of band, least privilege, no wildcards
      on resources that matter
- [ ] Frontend hosting
- [ ] Public URL for the product (only the webhook endpoint is public)

## 21. Observability / security

- [x] Structured JSON logs across Lambda and the Fargate task
- [x] Investigation id, delivery id and repository in logs for correlation
- [x] CloudWatch log groups with 14-day retention; Step Functions execution logging
- [x] CloudWatch alarm on webhook handler errors
- [x] **No secret leakage**: 185,667 characters of task, Lambda and Step Functions
      logs scanned — no private key, JWT, installation token, HMAC secret or
      OpenRouter key shape
- [x] Built frontend bundle scanned — no credential present
- [x] `skill.md` and `openrouter_api.md` gitignored, untracked, never committed
- [ ] Metrics/dashboard for investigation outcomes

## 22. Testing

- [x] **252 tests passing** (133 Python + 119 TypeScript), 3 skipped
      (skips require ripgrep, which the container provides)
- [x] Typecheck clean, lint clean
- [x] Webhook signature validation, forged/tampered/legacy-scheme rejection (40)
- [x] Orchestrator: allowed and forbidden transitions, duplicate events,
      retry/failure behaviour, malformed events (42)
- [x] Sandbox isolation tested by executing real containers
- [x] Allowlist boundary: traversal, injection, flag smuggling
- [x] Analyzer tested against both the risky and the safe commit
- [x] Model router: failover, budgets, honest degradation, no credential leakage
- [x] API authentication and authorization boundaries (15)
- [x] UI render and truthful-provenance tests (9)
- [x] SAM template validates
- [ ] End-to-end test covering the finding → approval → remediation path on AWS

## 23. README / write-up

- [x] README explains the problem, trust model, sandbox security and analyzer
- [x] Honest status table and limitations section
- [ ] Update for the deployed AWS architecture and the replay evidence
- [ ] Architecture diagram
- [ ] Screenshots
- [ ] "What we learned" section grounded in the real failures encountered

## 24. Demo video

- [ ] Credential-exposure investigation recorded end to end
- [ ] AWS architecture segment
- [ ] Learning segment
- [ ] 3-minute cut

## 25. Final submission

- [ ] Public repository tidy, no secrets, accurate documentation
- [ ] Demo video linked
- [ ] Submission form completed

---

## Critical path

Only these block the final demo, in execution order:

1. **Credential-exposure fixture reaches `AWAITING_APPROVAL` on AWS.**
   Push the fixture's risky commit to a monitored repository so the real
   GitHub → webhook → EventBridge → Step Functions → Fargate path produces a
   finding with evidence, verification, blast radius and recommendation.
2. **Wire the UI to AWS.** The UI exists and works; it needs an AWS-backed API
   (investigation read + event stream) instead of `localhost:8787`.
3. **Populate the OpenRouter secret and redeploy** with
   `ModelSecretPopulated=true`; verify an AI-backed run on AWS.
4. **Implement the GitHub remediation PR** — the one genuinely missing feature.
5. **Post-fix verification on AWS**, closing `AWAITING_APPROVAL → REMEDIATING →
   POST_FIX_VERIFY → RESOLVED`.
6. **Deploy the frontend** and obtain a public URL.
7. **Record the 3-minute demo** and update the README.

Everything else on this list is either done or explicitly stretch.
