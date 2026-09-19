# Netra

**Netra investigates the consequences of code changes before they become incidents.**

> LLMs investigate. Deterministic code verifies. Humans authorize.

A diff can be five lines and still publish a credential. Code review asks *is this correct?*; scanners ask *does this contain a known vulnerability?* Netra asks a different question:

> **What can this change affect, and can we prove the consequence?**

**🔗 Live demo → [netra-prod-web-421946397122.s3-website.eu-north-1.amazonaws.com](http://netra-prod-web-421946397122.s3-website.eu-north-1.amazonaws.com)**

---

## The loop

```
GitHub push → webhook → EventBridge → Step Functions
  → Fargate investigator → isolated sandbox → controlled tools
  → evidence chain → blast-radius graph → deterministic verification
  → AWAITING_APPROVAL → human approval via UI
  → remediation PR on GitHub → post-fix verification → RESOLVED
```

Netra is built around making that one loop work end to end, rather than around a long list of partially-implemented scanners.

---

## Production status

Everything below runs on AWS. Click "Try the live demo" on the landing page to see a real CRITICAL investigation with evidence, blast-radius graph, and remediation PR.

| Capability | State |
|---|---|
| Investigation domain model and lifecycle | ✅ production |
| Isolated Docker sandbox with command allowlist | ✅ production (ECS Fargate) |
| Controlled investigation tools | ✅ production |
| Deterministic credential-exposure analyzer | ✅ production |
| Evidence chain and verification records | ✅ production (DynamoDB) |
| Blast-radius graph | ✅ production (DynamoDB + React Flow) |
| Live terminal event streaming (SSE) | ✅ production |
| Human approval boundary | ✅ production (API Gateway + Lambda) |
| Remediation PR creation via GitHub App | ✅ production |
| Post-fix verification | ✅ production |
| GitHub App + webhook pipeline | ✅ production (`Nakshatra480/Netra`) |
| AWS SAM deployment (API GW + Lambda + DynamoDB + ECS + Step Functions) | ✅ production (eu-north-1) |
| Demo mode with real production data | ✅ working |
| Provider-agnostic model router (OpenRouter → Ollama → deterministic) | ✅ implemented |
| Amazon Cognito authentication | ✅ implemented; pool not seeded for hackathon |

Nothing is simulated. Where something is unavailable, the UI says so rather than pretending it ran.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    GitHub Repository                     │
│                  Nakshatra480/Netra                      │
└───────────────────┬─────────────────────────────────────┘
                    │ push webhook
                    ▼
┌─────────────────────────────────────────────────────────┐
│              AWS API Gateway (webhook)                   │
│         netra-prod-github-webhook Lambda                 │
└───────────────────┬─────────────────────────────────────┘
                    │ EventBridge event
                    ▼
┌─────────────────────────────────────────────────────────┐
│           Step Functions State Machine                   │
│  CreateInvestigation → RunInvestigation (ECS Fargate)   │
│  → ConfirmOutcome → ReachedApproval?                    │
│      ├─ AWAITING_APPROVAL → waits for human decision    │
│      └─ NoFindingToApprove → succeed                    │
└───────────────────┬─────────────────────────────────────┘
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
┌──────────────────┐  ┌────────────────────────────────┐
│  ECS Fargate     │  │  DynamoDB (netra-prod-          │
│  investigator    │  │   investigations)               │
│  - clones repo   │  │  pk=INV#{id}                   │
│  - runs pipeline │  │  sk=META|FINDING#|EVIDENCE#|   │
│  - sandbox tools │  │     VERIFY#|GRAPH|ACTION#      │
│  - writes to DB  │  └────────────────────────────────┘
└──────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│     API Lambda (netra-prod-api) — Fastify + SSE         │
│  GET /api/investigations/:id                            │
│  POST /api/investigations/:id/approve                   │
│  POST /api/demo/session                                 │
└───────────────────┬─────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│     React SPA (S3 static hosting)                       │
│  - Investigation workspace (blast radius, evidence,     │
│    terminal, approval panel)                            │
│  - Real-time SSE updates while investigating            │
└─────────────────────────────────────────────────────────┘
```

---

## Running the demo

1. Visit the [live URL](http://netra-prod-web-421946397122.s3-website.eu-north-1.amazonaws.com)
2. Click **Try the live demo** — no account needed
3. The hero investigation (`inv_fixture1789797123credexp`) shows a **CRITICAL** credential-exposure finding:
   - `vite.config.js` bundled `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` into the browser bundle
   - 18 evidence items trace the secret from env → config → bundler → browser
   - 9-node blast radius graph shows the full exposure path
   - Deterministic verifier confirms the exposure
   - Remediation PR link shows what Netra proposed
4. Use the approval panel to see the human decision boundary

---

## Triggering a real investigation

Any push to `Nakshatra480/Netra` fires the pipeline:

```bash
# The GitHub App is installed on Nakshatra480/Netra.
# Any push triggers the webhook → Step Functions → Fargate investigator.
git push origin <branch>
```

The investigation appears in the Investigations list within ~30 seconds.

---

## Local development

```bash
# Install dependencies
pnpm install

# Start the web app (hot reload)
cd apps/web && pnpm dev

# Start the API (local DynamoDB or AWS credentials required)
cd services/api && pnpm dev

# Run tests
pnpm test
```

### Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | web build | API Gateway URL |
| `NETRA_TABLE_NAME` | API Lambda | DynamoDB table |
| `NETRA_ALLOWED_ORIGINS` | API Lambda | CORS origins |
| `NETRA_DEMO_SESSION_SECRET` | API Lambda | Stable HMAC key for demo tokens |
| `NETRA_GITHUB_APP_SECRET` | ECS task (Secrets Manager) | GitHub App PEM + App ID |
| `NETRA_OPENROUTER_API_KEY` | ECS task (Secrets Manager) | Optional LLM provider |

---

## Project structure

```
Netra/
├── apps/
│   └── web/                   # React SPA (Vite + TypeScript)
├── packages/
│   └── domain/                # Shared TypeScript types
├── services/
│   ├── api/                   # Fastify API (Lambda handler)
│   ├── investigator/          # Python investigation pipeline (Fargate)
│   ├── orchestrator/          # Node.js orchestration Lambdas
│   ├── sandbox/               # Docker sandbox for tool execution
│   └── webhook/               # GitHub webhook receiver
├── infra/
│   └── template.yaml          # AWS SAM template
└── demo/
    └── vulnerable-repo/       # Fixture for credential-exposure demo
```

---

## Trust model

Netra's design is opinionated about where each kind of decision is made:

| Decision | Who makes it |
|---|---|
| What to investigate | Deterministic (webhook payload) |
| What commands to run | Controlled tool set (allowlist) |
| Whether exposure is real | Deterministic analyzer |
| What the evidence means | LLM (explains, doesn't decide) |
| Whether the fix is correct | Deterministic post-fix verifier |
| Whether to apply the fix | **Human** (required, not optional) |

The LLM is a narrator, not a gatekeeper. It can be wrong. The deterministic code that wraps it cannot be fooled by a prompt.

---

## Hackathon

Built for the **Ship It** hackathon. Category: **Best UI** + **Best Use of AI Agents**.

- Real AWS deployment, real GitHub App, real pipeline
- Every finding is proven by deterministic code, not just reported by an LLM
- Human approval is a hard boundary — the LLM cannot approve its own finding
