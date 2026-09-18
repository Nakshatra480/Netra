# Netra — Product Requirements Document

**Project:** Netra
**Tagline:** *Netra investigates the consequences of code changes before they become incidents.*
**Trust model:** *LLMs investigate. Deterministic code verifies. Humans authorize.*
**Hackathon target:** AWS First Commit — Ship It + Best UI
**Document status:** Authoritative current specification. Reflects what is built,
what is deployed, and what remains.

**Status labels used throughout**

| Label | Meaning |
|---|---|
| **IMPLEMENTED / VERIFIED** | Built, and observed working — locally, on AWS, or both. The evidence is stated. |
| **IMPLEMENTED / NOT YET VERIFIED** | Code exists and passes tests, but the end-to-end behaviour has not been observed in the target environment. |
| **TODO** | Not built. |
| **STRETCH** | Deliberately out of MVP scope. |

---

## 1. Executive summary

Netra is an event-driven change-investigation platform. A push or pull request
on a connected repository becomes an **investigation**: an isolated, evidence-
producing analysis of what the change can cause.

It is not an AI code reviewer. The distinction is the trust model. A language
model may *propose* a consequence; only deterministic code may mark it
**verified**; and only a human may authorize an action that changes a
repository. Every claim points at a file, a line, and the analyzer that produced
it.

The product is built around **one reliable loop**, not a catalogue of scanners:

```
CODE CHANGE
  → What changed?
  → What does it affect?
  → Did it expose anything?
  → Could it cross a security boundary?
  → Can we prove it?
  → What is the safest action?
  → Human approval
  → Remediation
  → Re-verification
```

**Where the project stands.** The ingestion and orchestration half is deployed on
AWS and has been exercised with a genuine GitHub event. The investigation
engine, evidence model, blast radius, approval boundary and remediation
generation are built and verified locally. The remaining work is to drive a
*finding-producing* change through the deployed path, connect the existing UI to
AWS, and close the approval → remediation → re-verification loop in production.

---

## 2. Problem

A diff can be five lines and still publish a credential.

Code review asks **"is this code correct?"**. Scanners ask **"does this contain a
known vulnerability?"**. Neither asks the question that matters when a change is
about to ship:

> **What can this change affect, and can we prove the consequence?**

A configuration change can move a secret into a browser bundle. A permission
change can widen access. A new data flow can send sensitive values somewhere
unintended. In each case the *diff* looks small; the *consequence* is not.

Engineering teams have limited review attention. A useful system must shorten
the distance between **change → consequence → evidence → action → verification**,
not lengthen the list of warnings.

---

## 3. Target user

> A developer or maintainer responsible for a GitHub repository who needs to
> understand the security consequences of a change before merging it.

Secondary: security engineers reviewing a suspicious change, platform engineers
reviewing infrastructure changes, and small teams with no dedicated security
function.

---

## 4. Product thesis

1. **Evidence over assertion.** Every finding points at concrete repository
   evidence.
2. **Deterministic verification is authoritative.** A model may form a
   hypothesis; only code may confirm it.
3. **Humans authorize consequential actions.** Netra proposes and stops.
4. **Isolation by default.** Repository contents are untrusted input.
5. **Event-driven.** A GitHub event becomes an AWS workflow.
6. **Honest degradation.** When a component is unavailable, the product says so
   rather than pretending.
7. **One reliable loop** beats many partial ones.

The central product object is an **Investigation**.

---

## 5. Core user journey

```
Landing → Sign in → Workspace → Connect GitHub → Select repository
                                      ↓
                          push / pull_request
                                      ↓
                         Investigation created
                                      ↓
        live telemetry · finding · evidence · verification · blast radius
                                      ↓
                          Recommendation shown
                                      ↓
                        Human approves or rejects
                                      ↓
                            Remediation PR
                                      ↓
                         Post-fix verification
                                      ↓
                                 RESOLVED
```

**Demo path.** A judge can also enter through **Try Demo**, which runs the same
pipeline against a controlled fixture repository with no GitHub setup. The demo
is the real engine, not a recording.

---

## 6. Core investigation lifecycle

Defined once in `packages/domain/src/status.ts` and reused by the API, the
orchestrator and the UI, so a state cannot mean different things in different
places.

```
RECEIVED → CREATED → PREPARING → INVESTIGATING → EVIDENCE_COLLECTION
        → VERIFYING → IMPACT_ANALYSIS → RECOMMENDATION
        → AWAITING_APPROVAL → REMEDIATING → POST_FIX_VERIFY → RESOLVED
```

Terminal states: `RESOLVED`, `REJECTED`, `FAILED`. `FAILED` is reachable from any
non-terminal state.

**The approval boundary is structural.** There is no transition from
`RECOMMENDATION` to `REMEDIATING`. The only route is through
`AWAITING_APPROVAL`. An investigation that finds nothing remediable may resolve
directly from `RECOMMENDATION`.

**Status: IMPLEMENTED / VERIFIED.** The forbidden transitions are asserted in
tests, and the deployed Fargate task walked `CREATED → … → RESOLVED` on AWS.

---

## 7. Finding, evidence and verification model

```
Finding → Evidence → Verification → Confidence → Recommendation
```

**Finding** — category, severity, title, plain-English description, impact,
subject (the credential or artifact), affected files, confidence, verification
status, recommendation, whether remediation is available, status.

**Evidence** — file, line, snippet, the *relationship* that makes it relevant,
evidence kind, verification status, the analyzer that produced it, and the exact
allowlisted command whose output contained it.

**Verification** — a stable verifier id (`secret-flow-v1`), a verdict, the claim
in plain language, the detail supporting it, duration, and phase (`PRE_FIX` or
`POST_FIX`).

**Confidence is derived from verification status**, never chosen by a model.

**Rules the system enforces rather than requests:**
- A model cannot set a verification status.
- An out-of-range severity from a model is dropped, not coerced — a silently
  corrected value would look like agreement that never happened.
- Only declared fields survive parsing; volunteered reasoning is discarded at the
  boundary and never stored, emitted or displayed.

**Status: IMPLEMENTED / VERIFIED** locally — `PRE_FIX VERIFIED` followed by
`POST_FIX REFUTED` on the fixture.

---

## 8. Blast-radius model

The graph answers **"what does this change touch?"** and is a rendering of what
was traced, not an illustration.

Node kinds: changed file, file, module, environment variable, secret,
dependency, endpoint, permission, data store, external service, finding.

Every node and edge carries the evidence ids that justify it. A node is marked
`onAffectedPath` only when it lies on a route from the change to the finding. An
accessible prose summary accompanies the graph.

Laid out left to right by distance from the change, which matches how the
investigation reads: what changed, what it reaches, what that adds up to.

**Status: IMPLEMENTED / VERIFIED** locally — 9 nodes, 11 edges, 8 on the affected
path for the fixture. Graph generation also ran inside the Fargate task on AWS.

---

## 9. Human approval model

Netra never silently remediates. The approval panel states:

- the finding and why it matters
- the evidence count and verification status
- the affected files
- the **exact diff** that will be applied
- the expected impact

Actions: **Reject** (with a recorded reason) or **Approve & create remediation**.

The approver is taken from the verified identity token. No route reads a user id
from a request body, so a client cannot claim to be someone else. The decision is
recorded in the audit trail.

**Status: IMPLEMENTED / VERIFIED** locally. **TODO** against the AWS pipeline.

---

## 10. Architecture

```
GitHub (Netra Security App)
        │  push / pull_request
        ▼
API Gateway  ──►  Lambda webhook receiver
                        │  verify HMAC
                        ▼
                  DynamoDB  (delivery claim — idempotency)
                        │
                        ▼
                  EventBridge  (Netra.CodeChange, + archive, + DLQ)
                        │
                        ▼
                  Step Functions  (investigation lifecycle)
                        │
                        ▼
                  ECS / Fargate  (one ephemeral investigation task)
                        │
                        ├── clone repository (App installation token)
                        ├── isolated analysis via allowlisted tools
                        ├── deterministic analyzers  ◄── authoritative
                        └── optional OpenRouter interpretation
                        │
                        ▼
                  DynamoDB  (investigation, events, findings, evidence, graph)
                        │
                        ▼
                  Web UI  (local today; AWS-backed = TODO)
```

The architecture is deliberately small. No service is present for appearance.

---

## 11. AWS service responsibilities

| Service | Responsibility | Status |
|---|---|---|
| **API Gateway** | Public HTTPS webhook endpoint | VERIFIED |
| **Lambda** | Webhook verification; three lifecycle task handlers | VERIFIED |
| **DynamoDB** | Delivery claims (idempotency); investigations and their results | VERIFIED |
| **EventBridge** | Decouples "GitHub said something changed" from "Netra investigates it"; archive enables replay | VERIFIED |
| **Step Functions** | Investigation orchestration, retries, failure recording, approval boundary | VERIFIED |
| **ECS / Fargate** | One ephemeral, isolated investigation task per change | VERIFIED |
| **ECR** | Investigator container image | VERIFIED |
| **Secrets Manager** | Webhook secret, GitHub App credentials, model provider keys | VERIFIED (model secret unpopulated) |
| **CloudWatch** | Structured logs, execution history, error alarm | VERIFIED |
| **SQS** | Dead-letter queue for undeliverable events | IMPLEMENTED / NOT YET VERIFIED |

**Not used, deliberately:** Amazon Bedrock (model access is through OpenRouter),
S3 (payloads are small enough for DynamoDB today), Amplify/Cognito in production
(see §19 and §26).

---

## 12. GitHub App integration

**App:** Netra Security · App ID `4992979` · slug `netra-security`

**Permissions (least privilege):** Metadata read · Contents read/write ·
Pull requests read/write
**Events:** `push`, `pull_request`
**Installation:** `Nakshatra480/Netra`, repository selection *selected*

Netra authenticates as the App and mints a short-lived **installation token** per
investigation. The token is scoped to the installation's repositories and expires
within the hour, so a leaked clone credential is worth little.

Credentials live in Secrets Manager (`netra/prod/github/app`) and never in source
control. Verified by minting an App JWT from the stored value and calling
`GET /app`, which returned the expected permissions and events.

**Status: IMPLEMENTED / VERIFIED.**

---

## 13. Webhook and idempotency design

```
verify signature → claim delivery → publish change → 202
```

The handler does only what cannot be deferred, because GitHub allows ten seconds
and retries anything slower. Live deliveries returned in 0.66–0.79 s.

**Signature verification.** HMAC SHA-256 over the exact delivered bytes, compared
in constant time — a plain equality check leaks the expected value one byte at a
time to anyone willing to measure. GitHub's legacy `sha1` scheme is refused.
Unsigned, forged and tampered deliveries return 401.

**Idempotency.** GitHub retries a delivery it considers failed, and the retry
carries the same `X-GitHub-Delivery` id. A conditional DynamoDB write decides the
winner, so two concurrent invocations cannot both proceed.

Three decisions make this correct rather than merely present:

1. The claim is taken **before** publishing.
2. If publishing fails, the claim is **released** — otherwise a claimed-but-
   unpublished delivery would look like a duplicate on retry and the change would
   be lost permanently. The claim would have turned a retryable failure into
   silent data loss.
3. If the claim store is unreachable, the delivery is **refused** (500) rather
   than acknowledged. Exactly-once cannot be promised, so processing would risk
   duplicate work.

**Proven end to end.** Delivery GUID `56d450a0-b392-11f1-9382-6535715b1e04`
returned `202` on first delivery and `200 duplicate` on redelivery; EventBridge
recorded three publishes for four deliveries. **A GitHub retry does not create a
second investigation.**

A second idempotency layer exists in the workflow: the investigation id is
derived deterministically from the delivery id, so idempotency does not depend on
a lookup succeeding first.

**Status: IMPLEMENTED / VERIFIED.**

---

## 14. Step Functions lifecycle

```
CreateInvestigation
   → AlreadyInvestigated?  ── duplicate ──► DuplicateIgnored (Succeed)
   → RunInvestigation  (ECS runTask.sync)
   → ConfirmOutcome
   → ReachedApproval?  ──► AwaitingApproval (Succeed)
                       ──► NoFindingToApprove (Succeed)
                       ──► FailInvestigation → FailExecution
```

`AWAITING_APPROVAL` is **terminal for this milestone**: the workflow contains no
remediation state, so nothing in this path can change a repository.

**Retries distinguish faults worth repeating from those that are not.** Transient
DynamoDB, Lambda and ECS capacity errors back off and retry. A malformed event is
rejected outright, because replaying it cannot make it valid.

**Success is decided by the stored record**, not by the task exiting zero:
`ConfirmOutcome` reads back what the investigation actually reached and fails the
execution if it stopped mid-lifecycle.

Every failure path records a readable reason, so an investigation is never left
silently stuck.

**Status: IMPLEMENTED / VERIFIED** — `netra-prod-investigation`, ACTIVE, STANDARD.

---

## 15. Fargate sandbox architecture

**The decision that shaped this section:** Fargate cannot nest containers. There
is no daemon, no socket and no privileged mode, so the local `DockerSandbox`
cannot run there. Rather than weaken it, the boundary moves up a level.

**On AWS, the Fargate task *is* the isolation boundary:**

- one ephemeral task per investigation
- non-root (uid 10001)
- no Docker socket, no privileged mode
- egress-only security group (HTTPS to GitHub and the model gateway)
- minimal IAM — the container may write investigation results and nothing else
- the ECS agent injects secrets, so the container itself has **no** Secrets
  Manager permission
- destroyed when the investigation ends

**Locally, a container per investigation** provides the boundary, because Netra
is then a process on a shared machine: `--network none`, `--read-only`,
`--cap-drop ALL`, `--security-opt no-new-privileges`, memory/CPU/PID limits, and
a read-only mount of an ephemeral copy.

Both sit behind one `SandboxExecutor` interface and run the same pipeline, so
there is no second implementation to keep in step. A test asserts the analyzer
reaches **the same verdict either way**.

Local isolation is verified by executing real containers and checking the uid,
the absence of any routable address or route, the read-only mounts, the missing
Docker socket and the inability to escalate.

**Status: IMPLEMENTED / VERIFIED.**

---

## 16. Tool execution and security model

```
model → tool name + typed arguments → validation → allowlist → executor → command
```

**Netra never executes a string produced by a model.** The model selects a
*tool* and supplies typed arguments. A builder validates each one and returns an
argv list that no longer contains caller-controlled structure.

- Only four binaries may ever appear as `argv[0]`: `git`, `rg`, `cat`, `find`.
- Searches are always `--fixed-strings`, so a query cannot become a pattern.
- `--` separates options from operands, so an argument cannot become a flag.
- Paths are validated against traversal, absolute paths, shell metacharacters and
  leading dashes.
- An unknown tool name or a rejected argument **executes nothing** and returns an
  error the model can read; the loop continues.

Tool use runs over an explicit JSON protocol rather than a provider-native tool
API, so the boundary is identical on every provider.

**Credential handling inside the task.** The clone token is passed through a git
**askpass helper**, never embedded in the remote URL — git records the remote in
`.git/config`, and a URL-embedded credential would persist into the very
workspace the analyzer then reads. Netra's own credentials are stripped from the
analysis process environment.

**Status: IMPLEMENTED / VERIFIED.**

---

## 17. Deterministic analysis

The MVP implements **one category deeply**: credential exposure / unsafe secret
flow (`secret-flow-v1`).

1. Read the **diff** and find secret-named identifiers the change *added* — this
   is an investigation of the change, not a repository-wide scan.
2. Derive the **browser surface** from the project's own bundler configuration,
   so the conclusion holds for this repository specifically.
3. Walk the **import graph** from the browser entry points.
4. Report a finding **only** when a concrete path is traced from an entry point
   to the credential read, or when the bundler is configured to inline it.

A change that does not do this produces no finding. Over-reporting is the failure
mode that makes security tools ignored.

The analyzer is verified against both commits of the fixture: it traces the
exposure on the risky commit and stays silent on the safe baseline.

**Status: IMPLEMENTED / VERIFIED.**

---

## 18. OpenRouter AI layer

**There is no Bedrock and no Strands in this system.** Model access is through
**OpenRouter**, behind a provider-agnostic interface.

```
OpenRouter (allowlisted model)  →  Ollama (local capable model)  →  deterministic only
```

The router owns provider selection, failover, budgets and usage accounting. No
step fabricates a response and no step loops. The UI shows the path that actually
ran:

```
OpenRouter · Claude Sonnet 4.5      Context 203 tokens · 1 turn · $0.0052
AI unavailable — deterministic analysis
```

**Model selection** comes from a server-side allowlist, never from user input or
from a model, across three tiers (DEEP / STANDARD / FAST). A deterministic
prefilter decides the tier, so the strongest model is not the default.

**Credential pool.** Several authorized keys can be configured as a *reliability*
failover pool — rate-limited keys are rested with growing backoff, exhausted keys
are retired, and each account is used within its own allowance. This is not a way
around any provider's limits.

**Token efficiency is a product requirement.** Netra never sends a repository to
a model. Deterministic analysis runs first and its compact result is the *only*
context the model receives. Context fragments are hashed and never sent twice;
long output is summarised with security-relevant lines preserved verbatim; turns,
tokens and cost are hard-bounded. Reaching a limit ends the *model's*
participation, not the investigation.

**The AI layer is optional.** With no model configured, the investigation still
produces a verified deterministic finding and reports
`AI unavailable — deterministic analysis`.

**Status:** **IMPLEMENTED / VERIFIED locally** — OpenRouter · Claude Sonnet 4.5,
one turn, 203 context tokens, $0.0052, through to `RESOLVED`.
**NOT YET VERIFIED on AWS** — `netra/prod/model/openrouter` is unpopulated, so the
deployed task runs deterministic-only.

---

## 19. Data model

**DynamoDB `netra-prod-investigations`** — PAY_PER_REQUEST, one partition per
investigation:

```
pk = INV#<investigationId>
sk = META | EVENT#<seq> | FINDING#<id> | EVIDENCE#<id> | VERIFY#<id> | GRAPH
```

Everything belonging to one investigation is a single query.

**DynamoDB `netra-prod-deliveries`** — delivery claims keyed on the GitHub
delivery id, TTL 7 days.

**Entities:** Workspace, Repository, Investigation, Finding, Evidence,
VerificationResult, BlastRadiusGraph, Remediation, Action, AuditEvent,
ModelProvenance.

**Model provenance** records provider, model, whether a model was used, fallback
reason, turns, tokens and cost — and never a credential.

Lifecycle events are persisted **as they happen**, so an investigation that dies
mid-flight shows how far it got rather than vanishing.

**Chain-of-thought is never stored.**

**Status: IMPLEMENTED / VERIFIED** — 43 events and a graph persisted by the AWS
task.

---

## 20. UI / UX specification

**Design direction:** dark-first, professional, calm, information-dense but
readable. Colour is semantic, not decorative — **red is reserved for proven
severity**, so a mostly-neutral screen is a mostly-fine change. No neon, no
cyberpunk, no decorative 3D.

**Stack (already implemented):** React · TypeScript · Tailwind · React Flow ·
xterm.js · Framer Motion · Lucide.

**Screens**

| Screen | Status |
|---|---|
| Landing / product explanation | IMPLEMENTED |
| Sign in (Cognito, with honest "not configured" state) | IMPLEMENTED |
| Command Center | IMPLEMENTED |
| **Investigation detail** (the demo screen) | IMPLEMENTED |
| Blast radius (React Flow) | IMPLEMENTED |
| Evidence + verification | IMPLEMENTED |
| Approval / action | IMPLEMENTED |
| Repositories / Activity / Settings | Placeholder — say so rather than showing invented data |

**Investigation page layout:** header (reference, repository, PR, commit,
severity, status) → one-sentence consequence → blast radius + evidence →
live terminal → AI provenance bar → approval panel.

**Investigation activity UX.** Concise activity summaries corresponding to real
backend work. Raw chain-of-thought is never displayed.

**Provenance is stated truthfully.** When no model ran, the UI says
`AI unavailable — deterministic analysis` and shows **no** turn count or cost,
because claiming usage for a run that never happened would be a lie. Verification
is labelled deterministic either way.

**Accessibility:** keyboard navigation, visible focus, semantic status, reduced
motion honoured, and a prose alternative to the graph.

**Status: IMPLEMENTED / NOT YET VERIFIED against AWS.** The UI currently reads
from the local API (`VITE_API_BASE_URL`, default `http://localhost:8787`).
Connecting it to the deployed pipeline is critical-path work.

---

## 21. API and event contracts

**Public endpoint (deployed)**

```
POST /github/webhook        GitHub deliveries; HMAC verified
```

**Application API (implemented locally)**

```
POST /api/demo/session              GET  /api/investigations
POST /api/workspaces                GET  /api/investigations/:id
POST /api/workspaces/mine           GET  /api/investigations/:id/events   (SSE)
GET  /api/repositories              GET  /api/investigations/:id/evidence
GET  /api/health                    GET  /api/investigations/:id/graph
GET  /api/audit                     POST /api/investigations/:id/approve
                                    POST /api/investigations/:id/reject
```

Every authenticated endpoint derives identity from a verified token.

**`Netra.CodeChange` event**

```
source:      netra.github
detail-type: Netra.CodeChange
detail:      { deliveryId, source, installationId,
               repository { fullName, githubId, defaultBranch, private },
               change { commitSha, baseSha, branch, pullRequestNumber, title, author },
               receivedAt }
```

`push` and `pull_request` describe the same thing in two shapes; the difference
is resolved once so no consumer has to. Pull-request actions that do not change
code (`closed`, `labeled`, `assigned`, `edited`) are acknowledged without being
investigated.

**Investigation telemetry events:** `status_changed`, `activity`,
`command_started`, `command_output`, `command_finished`, `finding_detected`,
`evidence_found`, `verification`, `graph_updated`, `remediation_proposed`,
`action_updated`.

---

## 22. Security model

| Control | Implementation |
|---|---|
| Webhook authenticity | HMAC SHA-256, constant-time, sha1 refused |
| Replay safety | Conditional-write delivery claim + deterministic investigation id |
| Untrusted repository contents | Ephemeral, non-root, isolated task; read-only workspace copy |
| Model → shell | Impossible by construction: tool name + typed args, four-binary allowlist |
| Clone credential | Short-lived installation token via git askpass, never in the remote URL |
| Secret distribution | ECS agent injects; the container has no Secrets Manager permission |
| Secrets at rest | Secrets Manager; webhook secret generated by AWS and never written down |
| Identity | Verified token claims only; client-supplied ids ignored |
| IAM | Least privilege, no wildcards on resources that matter; `PassRole` conditioned on service |
| Logs | Structured; no payloads, signatures, tokens or secrets |

**Verified:** 185,667 characters of task, Lambda and Step Functions logs scanned
— no private key, JWT, installation token, HMAC secret or OpenRouter key shape.
The built frontend bundle was scanned for credentials and is clean. Local secret
files are gitignored, untracked and absent from history.

---

## 23. Observability

- Structured JSON logs in every component
- Investigation id, delivery id and repository present for correlation
- CloudWatch log groups, 14-day retention
- Step Functions execution logging with execution *data* excluded (it can carry
  change detail)
- CloudWatch alarm on sustained webhook handler errors
- Model usage accounting: provider, model, tokens, cost, latency, fallback reason

**TODO:** a dashboard covering investigation outcomes and durations.

---

## 24. Testing strategy

**252 tests passing** (133 Python + 119 TypeScript), 3 skipped. Typecheck and
lint clean.

| Area | Coverage |
|---|---|
| Allowlist boundary | Traversal, injection, flag smuggling, oversized input |
| Sandbox isolation | Real containers: uid, no route, read-only mounts, no socket, no escalation |
| Analyzer | Risky commit *and* safe baseline; parity across both boundaries |
| Webhook | Signature validation, forged/tampered/legacy rejection, idempotency, log hygiene |
| Orchestrator | Allowed and forbidden transitions, duplicates, retries, malformed events |
| Model router | Failover, budgets, honest degradation, no credential leakage |
| API | Authentication and authorization boundaries |
| UI | Render and truthful-provenance tests |
| Infrastructure | SAM template validation |

**TODO:** an end-to-end test covering finding → approval → remediation on AWS.

---

## 25. Failure and degradation behaviour

Netra is explicit about what it could not do.

| Condition | Behaviour |
|---|---|
| No model configured | Deterministic analysis runs; UI shows `AI unavailable — deterministic analysis` |
| All model capacity exhausted | Falls back, then degrades; never loops |
| Model budget reached | The model's turn ends, the investigation continues |
| Claim store unreachable | Delivery refused (500) so GitHub retries; no duplicate work |
| Publish fails after claim | Claim released so the retry behaves like a first attempt |
| Task fails | Failure recorded with a readable reason; execution fails loudly |
| Investigation ends mid-lifecycle | Treated as failure even if the task exited zero |

The UI never shows an investigation stuck on "Investigating…" without a reason.

---

## 26. Current implementation status

### IMPLEMENTED / VERIFIED

**Deployed on AWS and exercised with a genuine GitHub event**
- GitHub App created, installed, webhook live; signature verification tested
- Webhook Lambda, delivery idempotency, EventBridge publication and archive
- Step Functions `netra-prod-investigation` (ACTIVE)
- EventBridge rule `netra-prod-code-change` (ENABLED)
- ECS cluster `netra-prod`; task definition FARGATE / ARM64 / 1024 CPU / 2048 MB
- ECR investigator image; DynamoDB `netra-prod-investigations`
- Five least-privilege IAM roles; Secrets Manager for webhook and App credentials

**Archive replay result.** A genuine archived `Netra.CodeChange` event was
replayed. The execution succeeded in 43 s:

```
CreateInvestigation → AlreadyInvestigated? → RunInvestigation
  → ConfirmOutcome → ReachedApproval? → NoFindingToApprove
```

Inside the Fargate task: cloned `Nakshatra480/Netra` at `3822663130de`, prepared
an isolated workspace, and walked `CREATED → PREPARING → INVESTIGATING →
EVIDENCE_COLLECTION → VERIFYING → IMPACT_ANALYSIS → RECOMMENDATION → RESOLVED`,
persisting 43 events and a graph. The other three archived events stopped at the
duplicate gate.

> **What this proves:** event ingestion, idempotency, EventBridge routing, Step
> Functions orchestration, Fargate execution, repository cloning, the
> investigation lifecycle, persistence, and correct no-finding terminal
> behaviour.
>
> **What it does not prove:** the replayed commit was a documentation-only README
> change, so it correctly produced no finding. **The credential-exposure path,
> the approval boundary and remediation have not been demonstrated on AWS.**

**Verified locally (not yet on AWS)**
- Credential-exposure analyzer producing a CRITICAL verified finding
- Evidence chain, deterministic verification, blast radius
- Approval boundary, deterministic remediation patch, post-fix verification
  (`PRE_FIX VERIFIED` → `POST_FIX REFUTED` → `RESOLVED`)
- Live terminal telemetry over SSE
- OpenRouter model router with Claude Sonnet 4.5
- Web UI across landing, Command Center and Investigation

### IMPLEMENTED / NOT YET VERIFIED

- Web UI against AWS data — it reads the local API today
- OpenRouter on AWS — the secret is unpopulated
- Cognito authentication — code is complete, but **no user pool exists** in IaC
  or in AWS, so demo mode is the only working sign-in path
- SQS dead-letter queue — created but never exercised

### TODO

- Credential-exposure fixture through the deployed path to `AWAITING_APPROVAL`
- **GitHub remediation PR creation** — not implemented anywhere; remediation
  currently applies a patch to a local branch and commits
- Post-fix verification on AWS
- Frontend hosting and a public product URL
- README architecture diagram, screenshots and learning section
- Demo video

### STRETCH

Permission-boundary analysis · additional finding categories · S3 artifact
storage · Cognito and hosting in production · analytics · notifications

---

## 27. Remaining implementation plan

Ordered by what the demo requires.

1. **Credential-exposure fixture reaches `AWAITING_APPROVAL` on AWS.** Push the
   fixture's risky commit to a monitored repository so the real path produces a
   finding, evidence, verification, blast radius and recommendation. This is the
   single most important remaining item: it converts a working pipeline into a
   working *product*.
2. **Wire the UI to AWS.** The UI exists and works; it needs an AWS-backed read
   API and event stream.
3. **Populate the OpenRouter secret**, redeploy with `ModelSecretPopulated=true`,
   and verify an AI-backed run in which interpretation is *attached to* evidence
   rather than replacing verification.
4. **Implement the GitHub remediation PR** using the App's Contents and Pull
   requests permissions; record the PR URL on the action.
5. **Post-fix verification on AWS**, closing `AWAITING_APPROVAL → REMEDIATING →
   POST_FIX_VERIFY → RESOLVED`.
6. **Deploy the frontend** and obtain a public URL.
7. **README, architecture diagram, screenshots, demo video.**

---

## 28. Hackathon scope guardrails

**Netra is not** a SAST platform, a SIEM, a vulnerability manager, a SOC
platform, a Kubernetes security tool, a multi-cloud posture product, or an
autonomous remediation agent.

**One finding category, done well:** credential exposure / unsafe secret flow.

**Cut first if time runs short:** analytics, notifications, extra analyzers,
multi-agent orchestration, team permissions, marketing polish.

**Never cut:** the investigation, real telemetry, evidence, deterministic
verification, blast radius, human approval, the AWS workflow, demo mode, and the
README plus demo video.

The objective is one technically credible investigation loop that feels real,
trustworthy and unmistakably built on AWS — not the largest feature list.

---

## 29. Three-minute demo storyboard

**0:00–0:15 — The problem**
> "A developer pushes a change. Review tells you what changed. Netra investigates
> what that change can *cause*."

**0:15–2:15 — The working product**
GitHub change → Netra receives it → live investigation telemetry → changed files
→ finding → evidence → blast radius → deterministic verification → AI
interpretation (if configured) → recommendation → **human approval** →
remediation → post-fix verification → **RESOLVED**.

The visible transition: `DETECTED → INVESTIGATING → AWAITING APPROVAL →
APPROVED → REMEDIATING → VERIFYING → RESOLVED`.

**2:15–2:45 — AWS architecture**
GitHub → API Gateway / Lambda → DynamoDB idempotency → EventBridge → Step
Functions → ECS/Fargate → DynamoDB → UI.

Explain **why Fargate is the isolation boundary**: repository contents are
untrusted, Fargate cannot nest containers, so the task itself is the boundary —
ephemeral, non-root, minimal IAM, destroyed afterwards.

**2:45–3:00 — Learning**
Event-driven AWS workflow, Step Functions orchestration, Fargate isolation,
GitHub App integration, delivery idempotency, evidence plus deterministic
verification, and deploying a real investigation pipeline to AWS.

---

## 30. README / write-up requirements

Judges mostly see the repository, the write-up and the video. The README must
make it immediately clear:

1. Who Netra is for and what problem it solves
2. What actually happens when a change arrives
3. Why AWS is essential rather than incidental
4. The trust model — LLMs investigate, deterministic code verifies, humans
   authorize
5. The sandbox security model and why Fargate is the boundary
6. **What genuinely works today**, with evidence, and what does not
7. What the team learned from real failures
8. Architecture diagram, screenshots, demo video, setup and testing instructions

The honest status table is an asset, not a liability. A precise account of what
is verified is more persuasive than a feature list.

---

## 31. Learning narrative

Grounded in failures actually encountered while building this.

**Step Functions definitions are parsed before substitution.** An unquoted
`${SubnetIds}` placeholder standing in for a JSON array made the definition
unparseable. Validating the definition *after* substituting by hand passed and
hid the problem entirely.

**A task exiting zero is not success.** `ConfirmOutcome` initially received the
whole execution state instead of an `investigationId`, so it failed every run —
*after* the Fargate task had completed the investigation correctly — and
overwrote a good result with a failure.

**An optional dependency must not block startup.** The OpenRouter secret was
referenced unconditionally, and ECS refuses to start a task whose secrets it
cannot resolve. "No model configured" became "no investigation at all" — exactly
the degradation the design promises not to make.

**Error messages need a person in mind.** An ECS failure arrives as the entire
task description; the one useful sentence was buried under network interfaces and
ARNs on the investigation record.

**IAM is discovered one action at a time.** Deployment needed `iam:CreateRole`,
then `iam:PassRole`, then `PassRole` extended to `events.amazonaws.com` — and
`AttachRolePolicy` was never available, which forced inline policies that turned
out *tighter* than the AWS managed ones they replaced.

**Idempotency has an ordering requirement.** Claiming a delivery before
publishing is correct only if the claim is released when publishing fails.
Otherwise the claim converts a retryable failure into permanent data loss.

**Not every gateway is what its documentation says.** A model gateway's own docs
claimed no Claude access and no tool support; probing the live API showed
otherwise for the first and confirmed the second. Provider behaviour is worth
testing rather than reading.

---

## 32. Acceptance criteria

The MVP is complete when this holds:

> A change that exposes a credential is pushed to a connected repository. Netra
> receives the event through API Gateway, deduplicates the delivery, routes it
> through EventBridge to Step Functions, runs an isolated investigation on
> Fargate, produces a finding with evidence, verifies it deterministically,
> builds a blast radius, presents a recommendation, **stops for human approval**,
> creates a remediation pull request once approved, re-runs the same verification
> against the fix, and reaches `RESOLVED` — all visible in the UI.

**Met so far:** ingestion, idempotency, routing, orchestration, isolated
execution, lifecycle, persistence, no-finding terminal behaviour.

**Not yet met:** the finding path on AWS, approval on AWS, the remediation PR,
post-fix verification on AWS, and the UI reading from AWS.

---

## 33. Final submission checklist

- [ ] Credential-exposure investigation reaches `AWAITING_APPROVAL` on AWS
- [ ] UI reads investigations from AWS
- [ ] OpenRouter secret configured; AI-backed run verified on AWS
- [ ] Remediation PR created via the GitHub App
- [ ] Post-fix verification reaches `RESOLVED` on AWS
- [ ] Frontend deployed; public URL works
- [ ] README updated with architecture diagram, screenshots and learning
- [ ] Three-minute demo video recorded
- [ ] Repository contains no secrets and no inaccurate claims
- [ ] Submission form completed

See `task.md` for the full task-level checklist and the critical path.
