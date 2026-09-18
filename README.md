# Netra

Netra investigates the consequences of code changes before they become incidents.

> LLMs investigate. Deterministic code verifies. Humans authorize.

This repository is monitored by the Netra Security GitHub App.

## Webhook verification

This line was added to verify the end-to-end webhook pipeline:
GitHub -> API Gateway -> Lambda -> DynamoDB claim -> EventBridge.
