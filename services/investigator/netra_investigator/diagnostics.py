"""Operator diagnostics for the model layer.

Two commands, both safe to run and paste: they print provider health and model
availability, and never print a credential.
"""

from __future__ import annotations

import sys
from typing import TextIO

from .config import InvestigatorConfig
from .providers import Message, ModelRequest, Tier, build_router
from .providers.ollama import SUGGESTED_MODEL, OllamaProvider


def doctor(config: InvestigatorConfig, out: TextIO | None = None) -> int:
    """Report what the model layer can currently do."""
    stream = out or sys.stdout
    router = build_router(config)
    health = router.health()

    remote = health["openRouter"]
    stream.write("OpenRouter\n")
    if not remote["configured"]:
        stream.write("  not configured (set OPENROUTER_API_KEYS)\n")
    else:
        credentials = remote["credentials"]
        stream.write(f"  credentials: {len(credentials)} configured\n")
        for entry in credentials:
            stream.write(f"    {entry['key']}  {entry['state']}\n")
        for tier in (Tier.DEEP, Tier.STANDARD, Tier.FAST):
            models = ", ".join(config.models_by_tier.get(tier, [])) or "none"
            stream.write(f"  {tier.value:<9} {models}\n")

    local = OllamaProvider(base_url=config.ollama_base_url, preferred_model=config.ollama_model)
    stream.write("\nOllama (local fallback)\n")
    installed = local.installed_models()
    if not installed:
        stream.write("  not running, or no models installed\n")
    else:
        stream.write(f"  installed: {', '.join(installed)}\n")
    resolved = local.resolve_model()
    if resolved:
        stream.write(f"  selected:  {resolved}\n")
    else:
        stream.write(f"  {local.diagnosis()}\n")
        stream.write(f"  suggestion: ollama pull {SUGGESTED_MODEL}\n")

    blocked = router.preflight()
    stream.write("\nInvestigation path\n")
    if blocked is None:
        stream.write("  a model is available; investigations will be interpreted\n")
        return 0
    stream.write(f"  no model available: {blocked}\n")
    stream.write("  investigations still run deterministic analysis and say so\n")
    return 1


def smoke(config: InvestigatorConfig, out: TextIO | None = None) -> int:
    """Make one minimal real request and print safe metadata only.

    Deliberately tiny: a few tokens in, a few out. Not part of the normal test
    suite, because the normal test suite must not spend anyone's credits.
    """
    stream = out or sys.stdout
    router = build_router(config)

    blocked = router.preflight()
    if blocked is not None:
        stream.write(f"no model available: {blocked}\n")
        return 1

    completion = router.generate(
        ModelRequest(
            system="You reply with exactly what you are asked for and nothing else.",
            messages=(Message(role="user", content="Reply with exactly: NETRA_OK"),),
            max_tokens=24,
            tier=Tier.FAST,
        )
    )
    if completion is None:
        stream.write(f"no completion: {router.outcome.unavailable_reason}\n")
        return 1

    stream.write(f"provider : {completion.provider}\n")
    stream.write(f"model    : {completion.model}\n")
    stream.write(f"reply    : {completion.text.strip()[:40]!r}\n")
    stream.write(f"tokens   : {completion.input_tokens} in / {completion.output_tokens} out\n")
    stream.write(f"cost     : ${completion.cost_usd or 0:.6f}\n")
    stream.write(f"latency  : {completion.latency_ms}ms\n")
    if router.outcome.fallback_reason:
        stream.write(f"fallback : {router.outcome.fallback_reason}\n")
    return 0


__all__ = ["doctor", "smoke"]
