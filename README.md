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
| Strands agent over Amazon Bedrock | ⚠️ implemented; Bedrock invoke blocked by AWS account verification |
| GitHub App and webhooks | ⛔ not built — needs a GitHub App |
| Firebase authentication | ⚠️ implemented; needs project configuration |
| AWS deployment (SAM) | ⛔ not built yet |

Nothing in the table is simulated. Where something is unavailable, the product
says so in the UI rather than pretending it ran.

---

## The trust model

This is the part worth understanding.

**A language model may propose a consequence. Only deterministic code may mark it
verified.**

* The agent (`services/investigator/netra_investigator/agent.py`) investigates
  with structured tools and returns a short reviewer-facing narrative plus the
  hypotheses it wants checked. It cannot set a verification status, and its
  private reasoning is discarded at the parse boundary — it is never emitted,
  stored, or displayed.
* The analyzer (`analyzers/secret_flow.py`) re-derives the exposure from the
  repository independently of anything the model said. It is what produces
  `VERIFIED`.
* If the model contradicts what was proven, the deterministic description wins.
  If Bedrock is unavailable, the investigation continues and the UI states that
  the model was unavailable.

Confidence is derived from verification status. It is never a number a model
chose.

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

Requirements: Node 20+, pnpm, Python 3.12, Docker, AWS CLI (for Bedrock).

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
* **Bedrock invoke is currently blocked** on this AWS account pending
  verification, so investigations run deterministic-only and say so.
* **GitHub integration is not built**, so changes enter through demo mode rather
  than a webhook.

---

## Credits

Built with React, Vite, Tailwind CSS, React Flow, xterm.js, Framer Motion,
Fastify, Zod, Strands Agents, Amazon Bedrock, Docker and ripgrep.

Developed with Claude Code (Claude Opus 5) as a pair-programming assistant.
