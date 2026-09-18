# Netra — Product Requirements Document

**Project:** Netra  
**Tagline:** *Netra investigates the consequences of code changes before they become incidents.*  
**Principle:** *AI investigates. Deterministic checks verify. Humans authorize.*  
**Hackathon target:** AWS First Commit — Ship It + Best UI  
**Document status:** Hackathon MVP / production-oriented architecture  
**Primary users:** Developers, maintainers, security engineers, DevOps/platform engineers, small engineering teams

---

## 1. Executive Summary

Netra is an event-driven developer security and change-impact investigation platform.

Instead of treating a pull request or commit as merely a code-review artifact, Netra investigates **what the change can cause**:

1. What changed?
2. What does the change affect?
3. Does it cross a security boundary?
4. Could it expose credentials, permissions, data, or infrastructure?
5. What evidence supports the finding?
6. Can deterministic checks verify the claim?
7. What is the safest next action?
8. After approval, did the remediation actually work?

Netra combines an AI investigation agent with deterministic verification, repository analysis, an isolated execution environment, an interactive blast-radius graph, evidence chains, human approval, and automated remediation/re-verification.

The product is intentionally designed around **one reliable end-to-end workflow** rather than a large collection of disconnected security features.

---

# 2. Problem Statement

## 2.1 The problem

A code change can look small in a diff while having consequences far beyond the changed lines.

For example:

- a configuration change can expose a credential;
- a permission change can expand access to sensitive resources;
- a dependency change can introduce a risky transitive dependency;
- a new data flow can move sensitive information into an unintended destination;
- an infrastructure change can affect multiple downstream resources.

Traditional code review primarily asks:

> **"Is this code correct?"**

Security scanners often ask:

> **"Does this code contain a known vulnerability?"**

Netra asks a different question:

> **"What can this change affect, and can we prove the consequence?"**

## 2.2 Why the problem matters

Engineering teams have limited review time. A useful security system must reduce the distance between:

**change → consequence → evidence → action → verification**

rather than producing another long list of warnings.

## 2.3 Target user

Netra is initially designed for:

> **A developer or maintainer responsible for a GitHub repository who wants to understand the security and operational consequences of important code changes before merging them.**

Secondary users:

- security engineers investigating suspicious changes;
- DevOps/platform engineers reviewing infrastructure changes;
- open-source maintainers;
- small engineering teams without dedicated security operations.

---

# 3. Product Vision

Netra should become a **change investigation workspace**, not another generic AI code-review dashboard.

### Vision

> Every important code change should have an understandable chain from **change → impact → evidence → action → verification**.

### Product principles

1. **Evidence over assertions**
   - AI findings must point to concrete repository evidence.

2. **Deterministic verification**
   - AI may propose hypotheses, but critical claims should be checked by deterministic tooling whenever possible.

3. **Human authorization**
   - Consequential actions require explicit user approval.

4. **Isolation by default**
   - Repository analysis happens in an isolated execution environment.

5. **Event-driven architecture**
   - A GitHub event should naturally become an AWS investigation workflow.

6. **Explain complexity, don't expose complexity**
   - The underlying system can be sophisticated while the UI remains understandable.

7. **One reliable core loop**
   - A complete investigation is more valuable than many partially implemented scanners.

---

# 4. Hackathon Strategy

Netra is optimized for the following judging dimensions:

| Criterion | Netra strategy |
|---|---|
| Idea & Impact | Focus on a specific problem: understanding consequences of repository changes |
| Built on AWS | AWS is part of the product workflow, not merely hosting |
| Learning | Demonstrate learning around Bedrock, Strands, Step Functions, event-driven AWS architecture and secure execution |
| Execution | Deliver one complete change-investigation loop end-to-end |
| Demo Video | Show a real GitHub change triggering a real AWS investigation, live terminal activity, evidence, blast radius, approval and verification |
| Best UI | Build a professional investigation workspace with interactive graph, evidence chain, terminal and approval UX |

### Core judging story

> **Netra doesn't just tell you that a change is risky. It investigates why, proves what it can prove, shows the blast radius, and lets a human decide what happens next.**

---

# 5. Goals

## 5.1 Primary goals

- Connect a GitHub repository to Netra.
- Receive GitHub push / pull-request events.
- Start an investigation automatically.
- Analyze the changed files and relevant repository context.
- Execute safe repository-analysis tools inside an isolated container.
- Show real investigation progress in the UI.
- Identify security or operational consequences.
- Build an interactive blast-radius representation.
- Attach evidence to findings.
- Run deterministic verification.
- Present a human-readable investigation report.
- Require explicit approval before consequential remediation.
- Create a remediation pull request for supported findings.
- Re-run verification after remediation.
- Store investigation history.
- Deploy the application on AWS so users can access it through a public URL.

## 5.2 Secondary goals

- Provide a demo repository for judges.
- Support a "Try Demo" experience without requiring GitHub setup.
- Make the architecture easy to understand from the README and demo.
- Make AWS usage visible in the product experience.

---

# 6. Non-Goals for the Hackathon

The following should **not** become MVP blockers:

- Full enterprise SIEM replacement.
- Full SAST/SCA platform.
- Complete vulnerability database.
- Kubernetes security platform.
- Production malware analysis.
- Arbitrary command execution.
- Autonomous merging of pull requests.
- Hundreds of security rules.
- Complete multi-cloud support.
- Building a custom LLM.
- 3D security visualization.
- A generic AI chatbot for repositories.

### Scope rule

If a feature does not improve the core loop:

**Change → Investigate → Prove → Explain → Approve → Remediate → Verify**

it should be treated as stretch scope.

---

# 7. Core Product Loop

```text
GitHub Change
     ↓
Event Received
     ↓
Investigation Created
     ↓
Repository Snapshot
     ↓
AI Investigation
     ↓
Controlled Analysis Tools
     ↓
Real Terminal Activity
     ↓
Findings
     ↓
Evidence Collection
     ↓
Blast Radius
     ↓
Deterministic Verification
     ↓
Human Approval
     ↓
Remediation PR
     ↓
Post-Fix Verification
     ↓
Resolved Investigation
```

---

# 8. User Journey

## 8.1 First-time user

### Step 1 — Landing page

User visits Netra.

Landing page communicates:

- what Netra does;
- who it is for;
- the core workflow;
- AWS-powered architecture;
- security philosophy;
- "Try Demo";
- "Sign in".

Primary CTA:

> **Investigate a Change**

Secondary CTA:

> **Try a Live Demo**

---

## 8.2 Authentication

User signs in using Firebase Authentication.

After authentication:

```text
Landing
  ↓
Sign in
  ↓
Workspace
```

The frontend receives an identity token.

The backend verifies the token before accessing user-specific data.

---

## 8.3 Workspace creation

User creates or enters a workspace.

Example:

```text
Workspace
└── Acme Engineering
```

Workspace contains:

- repositories;
- investigations;
- activity;
- settings;
- integrations;
- team members.

---

## 8.4 Connect GitHub

User selects:

> Connect GitHub

Netra uses a GitHub App installation flow.

The user chooses which repositories Netra can access.

Netra stores the installation/repository metadata rather than requiring broad personal credentials.

---

## 8.5 Repository onboarding

User selects:

> Add Repository

Netra performs an initial lightweight baseline analysis.

The repository page displays:

- repository name;
- default branch;
- last analyzed commit;
- monitoring status;
- recent investigations;
- risk summary;
- repository map.

---

# 9. Automated Investigation Journey

## 9.1 Change occurs

A developer pushes a commit or opens/updates a pull request.

GitHub sends an event to Netra.

```text
GitHub
   ↓
API Gateway
   ↓
Lambda webhook handler
   ↓
EventBridge
   ↓
Step Functions
```

---

## 9.2 Investigation starts

Netra creates an investigation record.

Example:

```text
INV-2026-0042

Repository:
payments-api

Change:
8f31c2a

Status:
Investigating
```

UI immediately displays the investigation timeline.

---

## 9.3 Repository analysis

Netra creates an isolated repository-analysis environment.

The agent receives access only through controlled tools.

Possible tools:

- `inspect_diff`
- `search_repository`
- `find_references`
- `analyze_dependencies`
- `inspect_config`
- `inspect_git_history`
- `analyze_permissions`
- `run_static_check`

The agent should not receive unrestricted host shell access.

---

## 9.4 Live terminal

The UI shows real commands executed by the analysis environment.

Example:

```text
$ git diff 8f31c2a^ 8f31c2a

$ rg "AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY" .

$ netra refs "AWS_SECRET_ACCESS_KEY"

$ netra permissions --changed-files

$ netra verify-secret-flow
```

The terminal is not decorative.

It represents actual controlled execution and exposes:

- command;
- stdout;
- stderr;
- exit code;
- duration;
- status.

---

# 10. Investigation Experience

The investigation screen is the central product surface.

## 10.1 Header

Display:

- investigation ID;
- repository;
- branch / PR;
- commit;
- current status;
- severity;
- timestamp.

Example:

```text
INV-0042
payments-api / PR #182

HIGH
Investigating
```

---

## 10.2 Investigation summary

Large, human-readable statement:

> A configuration change exposes a credential to a client-accessible environment.

Then:

```text
Why it matters
The changed environment variable is referenced by a frontend configuration path.

Evidence
3 repository locations

Blast radius
5 affected nodes

Verification
Confirmed by deterministic checks
```

---

# 11. Blast Radius

The blast-radius graph is one of Netra's primary visual differentiators.

## 11.1 Purpose

Show how a changed artifact connects to other repository artifacts.

Example:

```text
Changed Config
      ↓
Application Module
      ↓
API Handler
      ↓
Credential Consumer
      ↓
External Service
```

## 11.2 Graph nodes

Potential node types:

- changed file;
- module;
- function;
- environment variable;
- dependency;
- API endpoint;
- permission;
- data store;
- external service;
- finding.

## 11.3 Graph interactions

Users can:

- zoom;
- pan;
- select nodes;
- highlight paths;
- filter node types;
- focus on affected paths;
- open source evidence;
- jump from node to terminal evidence.

## 11.4 Visual principle

The graph should answer:

> **"What does this change touch?"**

within seconds.

---

# 12. Evidence System

Every important finding should contain an evidence chain.

## Evidence model

```text
Finding
   ↓
Evidence
   ↓
Verification
   ↓
Confidence
```

### Example

**Finding**

Credential may be exposed.

**Evidence**

```text
frontend/config.ts:18
```

references:

```text
AWS_SECRET_ACCESS_KEY
```

**Verification**

Deterministic repository search confirms the variable reaches a client configuration path.

**Confidence**

High.

---

# 13. Findings

Each finding should contain:

- title;
- severity;
- category;
- affected artifact;
- explanation;
- evidence;
- blast radius;
- verification result;
- recommendation;
- remediation availability;
- status.

Example categories:

### Credential Exposure

Sensitive credential or secret appears to flow into an unsafe location.

### Permission Boundary Change

Change expands access to a resource or capability.

### Dangerous Data Flow

Sensitive data moves to an unintended destination.

### Infrastructure Blast Radius

A configuration change affects more infrastructure than expected.

For the hackathon MVP, implement **one or two categories deeply** rather than four categories superficially.

---

# 14. Deterministic Verification

AI output is not sufficient for high-confidence security claims.

Netra therefore uses deterministic checks.

Examples:

```text
Pattern matching
Reference graph traversal
Dependency resolution
Configuration parsing
Permission rule evaluation
Git history comparison
Static analysis
```

The UI should distinguish:

```text
AI hypothesis
        vs
Verified evidence
```

This distinction is a core trust feature.

---

# 15. Human Approval

Netra should never silently execute consequential remediation.

The action panel should show:

```text
Recommended Action

Remove exposed credential reference
and create a remediation pull request.

Reason
The reference is reachable from a client-facing configuration path.

Evidence
3 verified locations

Potential impact
Frontend configuration

[ Review Changes ]
[ Approve & Create PR ]
[ Reject ]
```

The user remains the decision-maker.

---

# 16. Remediation

For supported findings:

1. Generate a proposed change.
2. Show the exact diff.
3. Require approval.
4. Create a GitHub pull request.
5. Record the action in the investigation audit trail.

Example:

```text
Netra remediation

- const token = process.env.AWS_SECRET_ACCESS_KEY
+ const token = await secureCredentialProvider()
```

The actual remediation must be appropriate to the specific finding and should never be generated as an unrestricted arbitrary change.

---

# 17. Post-Fix Verification

After remediation:

```text
PR created
    ↓
GitHub event
    ↓
New investigation
    ↓
Same verification suite
    ↓
Evidence comparison
    ↓
Resolved
```

Final state:

```text
RESOLVED

Original finding:
Verified

Remediation:
Merged / applied

Post-fix check:
Passed
```

This closes the loop.

---

# 18. Admin Journey

The admin journey is for workspace owners or administrators.

## 18.1 Admin dashboard

Admin sees:

- workspace overview;
- connected repositories;
- active investigations;
- unresolved findings;
- recent actions;
- system status;
- integration status.

---

## 18.2 Repository management

Admin can:

- add repository;
- remove repository;
- pause monitoring;
- resume monitoring;
- configure monitored branches;
- configure investigation categories.

---

## 18.3 Integration management

Admin can manage:

- GitHub App connection;
- webhook status;
- repository permissions;
- AWS integration status;
- authentication configuration.

---

## 18.4 Investigation policies

Potential settings:

```text
Require approval before remediation: ON

Automatic investigation on PR: ON

Monitor:
[x] Pull requests
[x] Pushes

Categories:
[x] Credential exposure
[x] Permission boundary changes
```

Avoid building a large policy engine for the hackathon.

---

## 18.5 Audit log

Admin can inspect:

```text
Timestamp
Actor
Repository
Investigation
Action
Result
```

Example:

```text
14:03  Atul
INV-0042
Approved remediation
Success
```

---

# 19. Feature Requirements

## P0 — Must Build

### Authentication

- Firebase Authentication.
- Protected application routes.
- Backend token verification.

### Workspace

- workspace creation;
- workspace selection;
- basic membership model.

### GitHub Integration

- GitHub App;
- repository selection;
- webhook reception.

### Investigation Engine

- investigation creation;
- event-driven workflow;
- repository snapshot;
- controlled analysis tools;
- Strands agent;
- Bedrock model integration.

### Sandbox

- isolated Docker execution environment;
- non-root execution;
- command allowlist;
- time/resource limits;
- no Docker socket;
- controlled/no external network by default.

### Evidence

- finding generation;
- evidence locations;
- deterministic verification;
- investigation timeline.

### Blast Radius

- repository relationship graph;
- interactive React Flow visualization.

### Live Terminal

- real command output;
- command status;
- timestamps;
- exit codes.

### Approval

- recommendation;
- diff preview;
- explicit approval;
- action audit record.

### Remediation

- supported remediation;
- GitHub PR creation.

### Re-verification

- repeat deterministic verification;
- resolved state.

### Public Deployment

- production frontend;
- production AWS backend;
- public URL;
- demo repository.

---

# 20. P1 — Should Build

- PR comments;
- notifications;
- repository baseline;
- investigation search;
- investigation filters;
- richer graph relationships;
- source-code viewer;
- audit log;
- demo mode;
- onboarding walkthrough.

---

# 21. P2 — Stretch

- multiple investigation categories;
- organization-level analytics;
- Slack notifications;
- scheduled repository scans;
- historical risk trends;
- custom policies;
- multi-agent investigation;
- advanced dependency analysis;
- team-level permissions.

---

# 22. AWS Architecture

## 22.1 Architecture principle

AWS must be part of the **functional execution path**, not merely the hosting provider.

### High-level architecture

```text
                         ┌──────────────────┐
                         │   React Web App  │
                         │ Amplify Hosting  │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │   API Gateway    │
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │      Lambda      │
                         │ API + Webhooks   │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │   EventBridge    │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │ Step Functions   │
                         │ Investigation    │
                         └────────┬─────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
           ┌────────────────┐          ┌────────────────┐
           │ Strands Agent  │          │ Repository     │
           │ + Bedrock      │          │ Sandbox        │
           └───────┬────────┘          └───────┬────────┘
                   │                           │
                   └─────────────┬─────────────┘
                                 ▼
                         ┌──────────────────┐
                         │ Evidence / Data  │
                         │ DynamoDB + S3    │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │ React UI         │
                         │ Investigation    │
                         └──────────────────┘
```

---

# 23. AWS Service Responsibilities

## Amazon API Gateway

Use for:

- application APIs;
- GitHub webhook endpoint;
- investigation APIs;
- approval/action APIs.

## AWS Lambda

Use for:

- API handlers;
- webhook validation;
- repository metadata operations;
- investigation orchestration helpers;
- GitHub API interactions.

## Amazon EventBridge

Use for:

- decoupling GitHub events from investigation processing;
- routing repository events;
- emitting investigation lifecycle events.

## AWS Step Functions

Use for the investigation state machine.

Example:

```text
Receive Event
    ↓
Create Investigation
    ↓
Prepare Repository
    ↓
Analyze Change
    ↓
Collect Evidence
    ↓
Verify
    ↓
Calculate Blast Radius
    ↓
Generate Recommendation
    ↓
Wait for Approval
    ↓
Remediate
    ↓
Verify Again
    ↓
Complete
```

Step Functions is especially important because the workflow is naturally multi-step and includes a human approval boundary.

## Amazon Bedrock

Use for:

- investigation reasoning;
- contextual analysis;
- evidence interpretation;
- impact explanation;
- remediation proposal.

Bedrock should not be responsible for deterministic verification.

## Strands Agents SDK

Use as the agent orchestration layer.

The agent should have explicit tools rather than arbitrary shell access.

## Amazon DynamoDB

Store:

- users/workspaces;
- repositories;
- investigations;
- findings;
- evidence metadata;
- actions;
- audit events;
- investigation status.

## Amazon S3

Store:

- repository-analysis artifacts;
- investigation snapshots;
- large logs;
- generated reports;
- optional graph/export artifacts.

## AWS Amplify Hosting

Use for:

- React frontend deployment;
- HTTPS;
- CI/CD;
- public access.

## Cedar / AWS Verified Permissions

If implemented within the MVP, use it for authorization decisions around consequential actions such as:

```text
Can this user approve remediation?
Can this workspace perform this action?
```

Do not build an elaborate authorization framework if it threatens the core demo.

---

# 24. Supporting Technology

| Area | Technology |
|---|---|
| Frontend | React + TypeScript |
| Styling | Tailwind CSS |
| UI components | shadcn/ui |
| Animation | Framer Motion |
| Graph | React Flow / XYFlow |
| Terminal | xterm.js |
| Authentication | Firebase Authentication |
| Repository | GitHub App |
| Agent | Strands Agents SDK |
| Model | Amazon Bedrock |
| Workflow | AWS Step Functions |
| API | API Gateway + Lambda |
| Eventing | EventBridge |
| Database | DynamoDB |
| Object storage | S3 |
| Hosting | Amplify |
| Authorization | Cedar / Verified Permissions where useful |
| Sandbox | Docker |
| Infrastructure | AWS SAM / CloudFormation |
| Testing | pytest + frontend test framework |
| Observability | CloudWatch |

---

# 25. UI / UX Requirements

Best UI is a separate evaluation area, so the interface should be treated as a first-class product deliverable.

## 25.1 Design direction

Netra should feel like a serious developer/security investigation product.

### Desired qualities

- professional;
- technical;
- calm;
- information-dense but readable;
- high trust;
- excellent hierarchy;
- fast;
- purposeful animation.

### Avoid

- generic SaaS dashboard appearance;
- excessive neon;
- cyberpunk aesthetic;
- excessive glassmorphism;
- giant decorative 3D scenes;
- meaningless animated numbers;
- red everywhere;
- visual noise.

---

# 26. Visual Language

## Typography

Use a highly readable sans-serif for application UI.

Use monospace typography for:

- code;
- terminal;
- commit hashes;
- file paths;
- command output;
- technical identifiers.

## Color system

Use semantic colors rather than decorative colors.

Example:

```text
Neutral  → system information
Blue     → active/investigating
Amber    → warning/review
Red      → verified/high severity
Green    → verified/resolved
```

Do not make the entire application red because it is a security product.

---

# 27. Application Layout

Recommended shell:

```text
┌──────────────────────────────────────────────────────────────┐
│ Netra       Workspace ▼                  Search   User       │
├──────────────┬───────────────────────────────────────────────┤
│              │                                               │
│ Command      │                                               │
│ Center       │              Main Investigation               │
│              │                                               │
│ Repositories │                                               │
│              │                                               │
│ Investigations                                               │
│              │                                               │
│ Activity     │                                               │
│              │                                               │
│ Settings     │                                               │
│              │                                               │
└──────────────┴───────────────────────────────────────────────┘
```

---

# 28. Core Screens

## 28.1 Landing

Must communicate the product in under 10 seconds.

Hero:

> **Investigate the consequences of every important code change.**

Supporting text:

> Netra traces impact, collects evidence, verifies findings and helps teams remediate safely.

Actions:

- Try Demo
- Sign In

Visual:

A subtle animated change → evidence → impact flow.

---

## 28.2 Command Center

Show:

- active investigations;
- repositories;
- unresolved findings;
- recent activity;
- system health.

Do not make this the primary wow screen.

---

## 28.3 Investigation Screen

This is the most important screen.

Recommended structure:

```text
┌───────────────────────────────────────────────────────────┐
│ Investigation / payments-api / PR #182          HIGH     │
├───────────────────────────────────────────────────────────┤
│ Summary                                                   │
│ "Credential may reach client-facing configuration."      │
├───────────────────────┬───────────────────────────────────┤
│                       │                                   │
│ Investigation Graph  │ Evidence                          │
│                       │                                   │
│                       │ 3 verified locations              │
│                       │                                   │
├───────────────────────┴───────────────────────────────────┤
│ Live Investigation Terminal                              │
│ $ git diff ...                                           │
│ $ rg ...                                                  │
├───────────────────────────────────────────────────────────┤
│ Recommendation                                            │
│ [Review Diff] [Approve Remediation]                      │
└───────────────────────────────────────────────────────────┘
```

---

# 29. Investigation Activity UX

The agent's internal reasoning should **not** be exposed as raw chain-of-thought.

Instead, display concise activity summaries:

```text
✓ Loaded changed files
✓ Identified credential reference
→ Searching repository references
→ Tracing configuration flow
✓ Found 3 related locations
→ Running deterministic verification
✓ Verification passed
```

This gives the user visibility without exposing private internal reasoning.

---

# 30. Terminal UX

The terminal should feel authentic.

Requirements:

- monospace;
- command prompt;
- streaming output;
- command duration;
- success/failure indicators;
- collapsible command blocks;
- auto-scroll;
- pause/resume scrolling;
- click evidence references;
- command status.

Example:

```text
INVESTIGATION TERMINAL

$ git diff --name-only
✓ 0.08s

src/config.ts
src/api/client.ts

$ rg "AWS_SECRET_ACCESS_KEY" src/
✓ 0.11s

src/config.ts:18
src/api/client.ts:42

$ netra verify-secret-flow
✓ 0.36s

Result: VERIFIED
```

---

# 31. Evidence UX

Evidence should look more like an investigation record than a normal code-review comment.

Example:

```text
EVIDENCE #03

src/config.ts:18

Environment variable:
AWS_SECRET_ACCESS_KEY

Referenced by:
→ src/api/client.ts
→ src/frontend/config.ts

Verification:
DETERMINISTIC CHECK PASSED
```

Allow users to:

- expand;
- copy;
- open source;
- highlight graph path;
- view verification command.

---

# 32. Blast Radius UX

The graph should be interactive but not overwhelming.

Features:

- animated traversal when investigation progresses;
- node selection;
- path highlighting;
- relationship labels;
- zoom controls;
- minimap;
- focus mode;
- "show affected path" action.

The graph should tell a story.

Example animation:

```text
Changed File
   ↓
Reference
   ↓
Sensitive Consumer
   ↓
Finding
```

Animation should represent real investigation state, not simulate fake work.

---

# 33. Approval UX

Approval is a critical trust moment.

Use a strong visual separation:

```text
┌──────────────────────────────────────────────┐
│ ACTION REQUIRES YOUR APPROVAL                │
│                                              │
│ Create remediation pull request              │
│                                              │
│ Why                                          │
│ Credential reference is verified.             │
│                                              │
│ Evidence                                     │
│ 3 locations                                  │
│                                              │
│ Proposed change                              │
│ [View Diff]                                  │
│                                              │
│ [Reject]              [Approve & Create PR] │
└──────────────────────────────────────────────┘
```

---

# 34. Responsive Design

The primary target is desktop because Netra is a developer/security tool.

Minimum support:

- desktop;
- laptop;
- tablet-friendly investigation view.

The terminal and graph should remain usable at smaller widths.

---

# 35. Accessibility

Required:

- keyboard navigation;
- visible focus states;
- sufficient contrast;
- semantic buttons;
- accessible status indicators;
- reduced-motion support;
- readable terminal text;
- graph alternative summary for users who cannot interact with the graph.

---

# 36. Motion Design

Use animation to communicate state.

Good uses:

- investigation begins;
- terminal command starts;
- graph path becomes active;
- finding is verified;
- approval panel opens;
- remediation completes;
- resolved state appears.

Avoid:

- constant floating particles;
- excessive page transitions;
- animations that delay user interaction.

---

# 37. Data Model

## Workspace

```text
id
name
ownerId
createdAt
```

## Repository

```text
id
workspaceId
githubInstallationId
githubRepositoryId
name
defaultBranch
monitoringEnabled
createdAt
```

## Investigation

```text
id
repositoryId
commitSha
pullRequestNumber
status
severity
summary
startedAt
completedAt
```

## Finding

```text
id
investigationId
category
severity
title
description
status
confidence
```

## Evidence

```text
id
findingId
file
line
snippet
evidenceType
verificationStatus
```

## Action

```text
id
investigationId
type
requestedBy
approvedBy
status
createdAt
```

## Audit Event

```text
id
workspaceId
actorId
action
resource
timestamp
result
```

---

# 38. API Requirements

Representative APIs:

```text
POST /api/workspaces
GET  /api/workspaces/:id

GET  /api/repositories
POST /api/repositories

POST /api/github/webhook

GET  /api/investigations
GET  /api/investigations/:id

GET  /api/investigations/:id/events
GET  /api/investigations/:id/evidence
GET  /api/investigations/:id/graph

POST /api/investigations/:id/approve
POST /api/investigations/:id/reject

POST /api/investigations/:id/remediate
```

All authenticated endpoints must validate the Firebase identity token server-side.

---

# 39. Security Requirements

## Repository isolation

Each analysis environment must:

- run as non-root;
- use an ephemeral workspace;
- have resource/time limits;
- not mount host filesystem broadly;
- not expose the Docker socket;
- avoid privileged mode;
- use controlled network access;
- be destroyed after investigation.

## Command execution

Do not allow the LLM to submit arbitrary host shell commands.

Instead:

```text
Agent
  ↓
Structured Tool
  ↓
Policy / Allowlist
  ↓
Sandbox Executor
  ↓
Command
```

## Secrets

- Never log GitHub installation secrets.
- Never display authentication tokens.
- Never persist repository credentials in investigation logs.
- Keep sensitive configuration in AWS-managed secret/configuration mechanisms.

---

# 40. Agent Design

## Agent responsibilities

The agent should:

1. understand the change;
2. select relevant analysis tools;
3. form investigation hypotheses;
4. gather evidence;
5. connect evidence;
6. explain potential impact;
7. request deterministic verification;
8. produce a recommendation.

## Agent should not

- directly execute unrestricted shell commands;
- independently approve remediation;
- claim verification without evidence;
- invent repository facts;
- expose hidden chain-of-thought.

---

# 41. Tool Contract

Example structured tool:

```text
search_repository(
    query: string,
    path?: string
)
```

Returns:

```json
{
  "matches": [
    {
      "file": "src/config.ts",
      "line": 18,
      "text": "..."
    }
  ]
}
```

Another:

```text
find_references(
    symbol: string
)
```

Another:

```text
verify_finding(
    finding_id: string
)
```

Tool outputs become evidence candidates.

---

# 42. Investigation State Machine

Recommended Step Functions states:

```text
RECEIVED
   ↓
CREATED
   ↓
PREPARING
   ↓
INVESTIGATING
   ↓
EVIDENCE_COLLECTION
   ↓
VERIFYING
   ↓
IMPACT_ANALYSIS
   ↓
RECOMMENDATION
   ↓
AWAITING_APPROVAL
   ↓
REMEDIATING
   ↓
POST_FIX_VERIFY
   ↓
RESOLVED
```

Failure state:

```text
FAILED
```

The UI must display state transitions clearly.

---

# 43. Demo Mode

Because judges should understand Netra without setup friction, provide:

> **Try Demo**

The demo should use a preconfigured repository and deterministic scenario.

Example scenario:

```text
Risky commit
      ↓
GitHub event
      ↓
Netra investigation
      ↓
Live terminal
      ↓
Finding
      ↓
Blast radius
      ↓
Evidence
      ↓
Verification
      ↓
Approval
      ↓
PR
      ↓
Verification
      ↓
Resolved
```

The demo must use real application flows, not a fake video-only simulation.

---

# 44. Observability

Use CloudWatch for:

- Lambda logs;
- Step Functions execution history;
- investigation failures;
- latency;
- sandbox failures;
- API errors.

Expose a simplified system-health view to admins.

Do not expose sensitive infrastructure logs directly to normal users.

---

# 45. Testing Strategy

## Backend

Test:

- webhook validation;
- investigation creation;
- authorization;
- deterministic analyzers;
- evidence generation;
- state transitions;
- remediation;
- post-fix verification.

## Agent

Use fixture repositories and deterministic test scenarios.

Evaluate:

- correct tool selection;
- evidence grounding;
- correct finding classification;
- no unsupported claims.

## Frontend

Test:

- authentication states;
- investigation loading;
- terminal streaming;
- graph rendering;
- approval flow;
- error states.

## End-to-end

At minimum:

```text
GitHub event
→ AWS workflow
→ investigation
→ finding
→ verification
→ approval
→ remediation
→ verification
```

---

# 46. Performance Requirements

Target, not absolute production SLA:

- Landing page loads quickly.
- Investigation page renders initial state immediately.
- Terminal events appear with low perceived latency.
- Investigation state updates without manual refresh.
- Graph renders within a few seconds for the supported demo repository.
- API errors provide actionable UI feedback.

---

# 47. Failure UX

Every asynchronous operation needs a visible failure state.

Example:

```text
Investigation paused

Netra could not prepare the repository sandbox.

[Retry Investigation]
[View Technical Details]
```

Never leave the UI stuck on:

```text
Investigating...
```

without explaining what happened.

---

# 48. Cost / AWS Design

Because the target is Ship It, AWS architecture should demonstrate meaningful use without unnecessary service sprawl.

Prioritize:

1. Lambda
2. API Gateway
3. EventBridge
4. Step Functions
5. Bedrock
6. DynamoDB
7. S3
8. Amplify

Add other AWS components only when they materially improve the workflow.

### Cost principle

Use:

- short-lived workloads;
- small demo repositories;
- bounded agent iterations;
- deterministic checks before expensive model calls where practical;
- lifecycle cleanup for sandbox artifacts.

The goal is not to maximize AWS service count.

---

# 49. Repository Structure

Suggested monorepo:

```text
netra/
├── apps/
│   └── web/
│
├── services/
│   ├── api/
│   ├── investigator/
│   ├── sandbox/
│   └── github/
│
├── packages/
│   ├── ui/
│   ├── domain/
│   └── analyzers/
│
├── infra/
│   ├── template.yaml
│   ├── step-functions/
│   └── policies/
│
├── demo/
│   └── vulnerable-repo/
│
├── tests/
│
├── README.md
└── PRD.md
```

---

# 50. Development Plan — 2 Days Remaining

## Day 1 — Core Investigation

### Must complete

- [ ] Repository initialized during hackathon period
- [ ] React application shell
- [ ] Landing page
- [ ] Firebase authentication
- [ ] Workspace
- [ ] GitHub App / demo repository path
- [ ] AWS infrastructure skeleton
- [ ] API Gateway
- [ ] Lambda
- [ ] DynamoDB
- [ ] EventBridge
- [ ] Step Functions
- [ ] Bedrock + Strands
- [ ] Docker sandbox
- [ ] One deterministic analyzer
- [ ] Investigation data model
- [ ] Investigation UI
- [ ] Terminal UI

### End-of-day checkpoint

A user should be able to trigger an investigation and see:

```text
event
→ investigation
→ real analysis commands
→ finding
```

---

# 51. Day 2 — Complete the Story

### Must complete

- [ ] Blast-radius graph
- [ ] Evidence panel
- [ ] Deterministic verification
- [ ] Recommendation panel
- [ ] Approval flow
- [ ] Remediation PR
- [ ] Post-fix verification
- [ ] Public AWS deployment
- [ ] Demo repository
- [ ] Production UI polish
- [ ] Demo video recording
- [ ] README
- [ ] Architecture diagram
- [ ] Learning section
- [ ] Final submission

### Hard cutoff

If remediation becomes unreliable, do not sacrifice the investigation workflow.

The minimum successful demo is:

```text
Change
→ Investigation
→ Terminal
→ Finding
→ Evidence
→ Blast Radius
→ Verification
→ Human Approval
→ Resolution
```

---

# 52. Demo Video Storyboard — 3 Minutes

## 0:00–0:15 — Problem

Show a developer reviewing a seemingly small change.

Narration:

> "A code change can be only a few lines, but its consequences can cross files, permissions, credentials and infrastructure. Netra investigates those consequences before they become incidents."

---

## 0:15–0:35 — Trigger

Show GitHub commit / pull request.

Then:

```text
GitHub
→ Netra
→ Investigation started
```

Explicitly show AWS event-driven flow visually.

---

## 0:35–1:15 — Live investigation

Show:

- investigation screen;
- agent activity;
- real terminal commands;
- repository search;
- evidence discovery.

---

## 1:15–1:45 — Blast radius

Show graph building from the changed file.

Zoom into affected nodes.

Show:

```text
Changed File
→ Reference
→ Sensitive Consumer
→ Finding
```

---

## 1:45–2:10 — Evidence + verification

Show evidence panel.

Then:

```text
AI hypothesis
↓
Deterministic verification
↓
VERIFIED
```

This is one of Netra's strongest trust moments.

---

## 2:10–2:30 — Human approval

Show recommendation and diff.

Click:

> Approve & Create PR

---

## 2:30–2:45 — Remediation

Show GitHub PR created.

---

## 2:45–3:00 — AWS + learning + final state

Quick architecture visualization:

```text
GitHub
→ EventBridge
→ Step Functions
→ Strands + Bedrock
→ Sandbox
→ DynamoDB/S3
```

Then show:

```text
POST-FIX VERIFICATION
PASSED

RESOLVED
```

Final line:

> "Netra turns code changes into investigations: evidence first, verified decisions, human-controlled action."

---

# 53. README Requirements

The README should contain:

1. Project overview
2. Problem
3. Solution
4. Architecture
5. AWS services and why they are used
6. Agent architecture
7. Sandbox security model
8. Investigation workflow
9. UI screenshots/GIFs
10. Demo video
11. Setup instructions
12. Local development
13. Deployment instructions
14. Testing
15. Limitations
16. Future work
17. **What we learned**
18. AI tools used during development
19. Open-source licenses/credits

---

# 54. Learning Narrative

The hackathon learning story should be explicit.

Potential learning points:

### AWS Step Functions

Learned how to model an investigation as a durable multi-step workflow with an explicit approval state.

### Amazon Bedrock

Learned how to integrate a managed foundation model into a grounded repository-investigation workflow.

### Strands

Learned how to build a tool-using agent where analysis capabilities are exposed through structured tools.

### EventBridge

Learned how repository events can initiate decoupled backend workflows.

### Secure execution

Learned how to analyze untrusted repositories through an isolated execution environment rather than giving an AI agent unrestricted host access.

### Human-in-the-loop systems

Learned how to separate:

```text
AI recommendation
from
deterministic verification
from
human authorization
```

---

# 55. Success Metrics

For the hackathon MVP:

### Functional

- A GitHub event can create an investigation.
- The investigation reaches a completed state.
- At least one meaningful finding is generated.
- Evidence is displayed.
- At least one finding is deterministically verified.
- Blast radius is visualized.
- Human approval is required.
- Remediation PR can be created for the supported scenario.
- Post-fix verification works.
- Product is accessible from a public AWS deployment.

### UX

A new user should understand:

1. what Netra does;
2. what changed;
3. why it matters;
4. what evidence supports it;
5. what can be affected;
6. what action is proposed;
7. what happens after approval.

without needing a technical explanation from the team.

---

# 56. Acceptance Criteria

The MVP is considered complete when this scenario works:

> A user connects or opens the demo GitHub repository. A risky code change occurs. Netra receives the event, creates an investigation through AWS, analyzes the repository inside an isolated environment, displays real investigation activity, identifies the supported security consequence, displays its blast radius and evidence, verifies the finding deterministically, asks the user for approval, creates a remediation PR, and verifies the repository again after the fix.

If this flow works reliably, the project has a complete product story.

---

# 57. Scope Guardrails

When time is limited, cut in this order:

### Cut first

- advanced analytics;
- notifications;
- multi-agent orchestration;
- custom policies;
- extra finding categories;
- team collaboration;
- fancy landing-page effects.

### Never cut

- investigation;
- real terminal activity;
- evidence;
- deterministic verification;
- blast radius;
- human approval;
- AWS workflow;
- public deployment;
- demo mode;
- README/demo video.

---

# 58. Final Product Positioning

Netra is not positioned as:

> "AI code review."

It is positioned as:

> **"An investigation layer for consequential code changes."**

The product's differentiating workflow is:

```text
             CHANGE
                │
                ▼
          INVESTIGATE
                │
        ┌───────┴────────┐
        ▼                ▼
     EVIDENCE        BLAST RADIUS
        │                │
        └───────┬────────┘
                ▼
          VERIFY CLAIM
                │
                ▼
        HUMAN DECISION
           │         │
        Reject     Approve
                     │
                     ▼
                REMEDIATE
                     │
                     ▼
              VERIFY AGAIN
                     │
                     ▼
                  RESOLVED
```

### Product promise

> **Netra investigates the consequences of code changes before they become incidents.**

### Trust model

> **AI investigates. Deterministic checks verify. Humans authorize.**

### Technical story

> **GitHub events trigger an AWS-native investigation workflow powered by Step Functions, Strands and Bedrock, with isolated repository execution, evidence storage, and human-controlled remediation.**

---

# 59. Final Priority Stack

If the team has to make a last-minute decision, prioritize in this exact product sequence:

```text
P0
│
├── Working investigation
├── AWS event-driven workflow
├── Real sandbox analysis
├── Real terminal
├── Evidence
├── Deterministic verification
├── Blast-radius graph
├── Human approval
├── Remediation
├── Post-fix verification
│
P1
├── Public deployment
├── Excellent UI
├── Demo mode
├── README
└── Demo video
│
P2
├── Extra analyzers
├── Analytics
├── Notifications
├── Multi-agent workflows
└── Enterprise features
```

**The objective is not to build the largest security platform in two days. The objective is to make one technically impressive investigation loop feel real, trustworthy, understandable, and unmistakably powered by AWS.**
