# Netra

**Netra investigates the consequences of code changes before they become incidents.**

> LLMs investigate. Deterministic code verifies. Humans authorize.

A diff can be five lines and still publish a credential. Code review asks *is this
correct?*; scanners ask *does this contain a known vulnerability?* Netra asks a
different question:

> **What can this change affect, and can we prove the consequence?**

---

## The loop

```
change → investigation → isolated sandbox → controlled tools → evidence
      → blast radius → deterministic verification → human approval
      → remediation → post-fix verification → resolved
```

Netra is built around making that one loop work end to end, rather than around a
long list of partially-implemented scanners.

---

## Status

| Capability | State |
|---|---|
| Investigation domain model and lifecycle | ✅ working |
| Isolated Docker sandbox with command allowlist | ✅ working |
| Controlled investigation tools | ✅ working |
| Deterministic credential-exposure analyzer | ✅ working |
| Evidence chain and verification records | ✅ working |
| Blast-radius graph | ✅ working |
| Live terminal event streaming (SSE) | ✅ working |
| Human approval boundary | ✅ working |
| Remediation and post-fix verification | ✅ working |
| Demo mode against a real fixture repository | ✅ working |
| Provider-agnostic model router (OpenRouter → Ollama → deterministic) | ✅ working |
| Token/context optimizer | ✅ working |
| Amazon Cognito authentication | ✅ implemented; needs a user pool to sign in |
| GitHub App and webhooks | ⛔ not built — needs a GitHub App |
| AWS deployment (SAM) | ⛔ not built yet |

Nothing in the table is simulated. Where something is unavailable, the product
says so in the UI rather than pretending it ran.

---

## The trust model

This is the part worth understanding.

**A language model may propose a consequence. Only deterministic code may mark it
verified.**

* The agent (`services/investigator/netra_investigator/agent.py`) receives the
  facts deterministic analysis already established and explains what they mean
  for a reviewer. It cannot set a verification status, an out-of-range severity
  is dropped rather than coerced, and its private reasoning is discarded at the
  parse boundary — never emitted, stored or displayed.
* The analyzer (`analyzers/secret_flow.py`) re-derives the exposure from the
  repository independently of anything the model said. It is what produces
  `VERIFIED`.
* If the model contradicts what was proven, the deterministic description wins.
  If no model is available, the investigation continues and the UI says
  `AI unavailable — deterministic analysis` rather than implying a model ran.

Confidence is derived from verification status. It is never a number a model
chose.

---

## AI architecture

Netra uses a **provider-agnostic model router**. OpenRouter provides the
preferred remote inference path for capable models such as Claude, while Ollama
provides a local fallback when remote inference is unavailable. Deterministic
analysis remains available independently of AI.

```
              investigation
                    │
         deterministic analysis          ← decides what is true
                    │
           context optimizer             ← decides what the model sees
                    │
              model router
              /            \
     OpenRouter             Ollama
   (allowlisted model)   (local capable model)
              \            /
            deterministic-only
```

The router owns provider selection, failover, budgets and usage accounting. The
UI always shows the path that actually ran:

```
OpenRouter · Claude Sonnet 4.5          Context 203 tokens · 1 turn · $0.0052
Ollama · qwen2.5-coder:7b               Fell back: all OpenRouter credentials …
AI unavailable — deterministic analysis
```

### Model selection

Models come from a **server-side allowlist**, never from user input or from a
model. Three tiers exist so the strongest model is spent where it matters:

| Tier | Used for |
|---|---|
| `DEEP` | complex blast-radius reasoning; a change touching many files or reaching a secret by several routes |
| `STANDARD` | ordinary investigation |
| `FAST` | short, well-bounded interpretation |

Escalation is earned: a deterministic prefilter decides the tier, so the most
capable model is not the default.

### Credential pool

Several authorized OpenRouter keys can be configured as a **reliability
failover pool**. This is not a way around anyone's limits — each account is used
within its own allowance:

* a key that reports a rate limit is rested with growing backoff, not hammered;
* a key whose budget is exhausted is retired rather than retried;
* when no authorized capacity remains, Netra falls back or degrades. It never
  loops.

Keys are held as non-reversible fingerprints (`key_38e99936`) everywhere they
are named, so health can be displayed without the secret existing outside the
provider process.

### Ollama is a local fallback only

Netra does **not** deploy Ollama to AWS. A hosted GPU runtime would cost more
than the rest of the system combined, for a path that is rarely taken. In
production, OpenRouter is the remote inference path and deterministic-only is
the fallback; Ollama serves local development and demos.

```bash
netra-investigate doctor   # what is configured, installed and reachable
netra-investigate smoke    # one minimal real request; prints safe metadata only
```

---

## Token efficiency

Token efficiency is treated as a product requirement, not a tuning detail. The
goal is maximum investigation quality per token, so Netra **never sends a
repository to a model**.

| Technique | What it does |
|---|---|
| **Deterministic-first** | Analysis runs before the model; its compact result is the only context the model receives |
| **Prefilter** | When there is no credential flow to interpret, no provider is contacted at all |
| **Diff-first** | Context starts from the change, not the tree |
| **Deduplication** | Every fragment is hashed; a fragment already sent is never repeated |
| **Summarization** | Long output is reduced to signal-carrying lines, with security-relevant lines preserved verbatim and elision marked |
| **Budgets** | Hard ceilings on turns, input tokens, output tokens, total tokens and cost |
| **Caching** | Deterministic results are content-addressed, so unchanged content is not recomputed |

Measured on the demo investigation: **203 tokens of context, one model turn, no
tool calls** — because the deterministic context was already sufficient.

Reaching a limit ends the *model's* participation, not the investigation:
deterministic analysis still produces the verified finding, and the UI says the
model stopped early.

---

## Sandbox security

Repository contents are untrusted input, so analysis never runs on the host.

```
agent → structured tool → allowlist → sandbox → command
```

Netra never executes a string produced by a model. The agent selects a *tool*;
the tool passes typed arguments to a builder in
`sandbox/allowlist.py`, which validates each one and returns an argv tuple. Only
four binaries can ever appear as `argv[0]` (`git`, `rg`, `cat`, `find`), searches
are always `--fixed-strings`, and `--` separates options from operands so an
argument can never become a flag.

The container itself:

| Control | How |
|---|---|
| Non-root | `--user 10001:10001` |
| No network | `--network none` |
| No privilege escalation | `--cap-drop ALL --security-opt no-new-privileges` |
| No Docker socket | never mounted |
| Read-only repository | `--volume …:/workspace:ro` on an *ephemeral copy* |
| Read-only root filesystem | `--read-only`, with a `noexec` tmpfs for scratch |
| Resource limits | memory, CPU, PID and output-byte caps |
| Time limits | per-command timeout, enforced by the executor |
| Cleanup | container killed and workspace deleted when the investigation ends |

These are verified by executing real containers, not asserted in comments — see
`tests/test_sandbox_isolation.py`, which checks the uid, the absence of any
routable address or route, the read-only mounts, the missing Docker socket and
the inability to escalate.

---

## How the analyzer proves an exposure

The supported category is **credential exposure / unsafe secret flow**, built
deeply rather than alongside nine shallow ones.

1. Read the **diff** and find secret-named identifiers the change *added*. This
   is an investigation of the change, not a repository-wide scan.
2. Derive the **browser surface** from the project's own bundler config, so the
   conclusion holds for this repository specifically rather than by convention.
3. Walk the **import graph** from the browser entry points.
4. Report a finding only when a concrete path is traced from an entry point to
   the credential read, or when the bundler is configured to inline it.

Each step becomes evidence with a file, a line, a snippet, the analyzer that
produced it and the exact command whose output contained it.

A change that does not do this produces no finding. Over-reporting is the failure
mode that makes security tools ignored.

---

## Remediation

The patch is **computed, not written by a model**. For a change that introduced
an exposure, the remedy is to undo exactly the part that causes it: the files on
the traced exposure path are restored to their pre-change contents and the rest
of the pull request is untouched.

The reviewer approves a diff, and `git apply` refuses anything that is not that
diff — so an approved review cannot turn into a different change.

Post-fix verification re-runs **the same analyzer** against the remediated
commit. `RESOLVED` means the check that proved the problem can no longer find it.

---

## Repository layout

```
apps/web/                 React investigation workspace
services/api/             Fastify API, SSE streaming, auth, persistence
services/investigator/    Python engine: sandbox, tools, analyzers, agent
packages/domain/          Shared lifecycle, data model and event contracts
demo/vulnerable-repo/     Real two-commit fixture with a real risky change
infra/                    AWS SAM templates
```

---

## Local development

Requirements: Node 20+, pnpm, Python 3.12, Docker. No model provider is
required — the demo works without one, and says so.

```bash
pnpm install
pnpm --filter @netra/domain build

# Build the sandbox image
docker build -f services/investigator/Dockerfile.sandbox \
  -t netra-sandbox:latest services/investigator

# Python engine
cd services/investigator
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e ".[dev]"
cd ../..

cp .env.example .env     # fill in what you have; the demo needs none of it

# Optional: enable AI interpretation
#   OPENROUTER_API_KEYS=sk-or-v1-...      (remote, preferred)
#   ollama pull qwen2.5-coder:7b          (local fallback)
# Check what is reachable:
cd services/investigator && .venv/bin/python -m netra_investigator doctor; cd ../..

pnpm --filter @netra/api dev     # http://localhost:8787
pnpm --filter @netra/web dev     # http://localhost:5173
```

Open the web app and choose **Try the live demo**. It builds a real git
repository, runs the real pipeline in a real container, and streams real command
output. Nothing is pre-recorded.

---

## Testing

```bash
pnpm -r test                                        # domain, API, web
cd services/investigator && .venv/bin/python -m pytest -q   # engine
```

The suite covers the allowlist boundary (traversal, injection, flag smuggling),
real container isolation, the analyzer against both the risky and the safe
commit, authentication and authorization boundaries, and the complete loop from
change to `RESOLVED`.

---

## Environment variables

See `.env.example`, which documents every variable and marks which are public
client values and which must stay server-side. Secrets belong in AWS Secrets
Manager in production; nothing secret is ever committed, logged or sent to the
model.

---

## Limitations

* **One finding category.** Credential exposure only. Permission-boundary changes
  are modelled but not implemented.
* **JavaScript/TypeScript repositories.** The import-graph walk and bundler
  parsing understand Vite projects; other stacks produce no finding rather than a
  wrong one.
* **Remediation is a bounded revert.** Netra can only undo lines the change
  added. It does not write new code.
* **GitHub integration is not built**, so changes enter through demo mode rather
  than a webhook.
* **No capable Ollama model is installed here**, so the local fallback reports
  itself unavailable rather than using an embedding model. `ollama pull
  qwen2.5-coder:7b` enables it.
* **AWS deployment is not built yet.** Cognito, API Gateway, Lambda,
  EventBridge, Step Functions, Fargate, DynamoDB and S3 are the target
  architecture; today the system runs locally.

---

## Credits

Built with React, Vite, Tailwind CSS, React Flow, xterm.js, Framer Motion,
Fastify, Zod, Docker and ripgrep. Model inference through OpenRouter and Ollama.
Authentication with Amazon Cognito.

Developed with Claude Code (Claude Opus 5) as a pair-programming assistant.
