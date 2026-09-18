"""Token and context optimization.

The goal is maximum investigation quality per model token, not the largest
possible context. Netra never sends a repository to a model. It sends the
change, the facts deterministic analysis already established, and nothing it
has sent before.

Techniques implemented here:

* **diff-first** -- context starts from the change, not the tree;
* **deterministic prefilter** -- cheap analysis runs first and decides whether a
  model is needed at all;
* **deduplication** -- every fragment is hashed, and a fragment already sent is
  referenced rather than repeated;
* **summarization** -- long command output is reduced to the lines that carry
  signal, while anything a verifier depends on is preserved verbatim;
* **budgets** -- an explicit character/token ceiling per investigation;
* **caching** -- deterministic results are keyed by content, so unchanged
  content is never recomputed.
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

#: Rough characters-per-token for English text and source code. Used only for
#: budgeting; real usage always comes from the provider.
CHARS_PER_TOKEN = 3.7

#: Lines that carry signal in command output even when trimming aggressively.
_SIGNAL = re.compile(
    r"(SECRET|PASSWORD|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|"
    r"process\.env|import\.meta\.env|define\s*:|error|Error|fatal)",
)


def estimate_tokens(text: str) -> int:
    """Approximate token count. Deliberately cheap; never authoritative."""
    return max(1, int(len(text) / CHARS_PER_TOKEN))


def fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


@dataclass(slots=True)
class Fragment:
    """One piece of context, with what it is and where it came from."""

    kind: str
    label: str
    body: str

    @property
    def digest(self) -> str:
        return fingerprint(self.body)

    def render(self) -> str:
        return f"### {self.kind}: {self.label}\n{self.body}"


@dataclass(slots=True)
class ContextBudget:
    """Ceiling on what one investigation may send to a model."""

    max_input_tokens: int = 60_000
    #: Per-fragment ceiling, so one enormous file cannot crowd out everything.
    max_fragment_tokens: int = 4_000

    @property
    def max_input_chars(self) -> int:
        return int(self.max_input_tokens * CHARS_PER_TOKEN)

    @property
    def max_fragment_chars(self) -> int:
        return int(self.max_fragment_tokens * CHARS_PER_TOKEN)


@dataclass(slots=True)
class ContextBuilder:
    """Assembles deduplicated, budgeted context for a model call."""

    budget: ContextBudget = field(default_factory=ContextBudget)
    _fragments: list[Fragment] = field(default_factory=list)
    _seen: set[str] = field(default_factory=set)
    _chars: int = 0

    #: Counters for usage observability.
    duplicates_skipped: int = 0
    fragments_truncated: int = 0
    fragments_dropped: int = 0

    def add(self, kind: str, label: str, body: str) -> bool:
        """Add a fragment unless it is empty, duplicated, or over budget.

        Returns whether it was added, so callers can tell the difference
        between "included" and "silently missing".
        """
        text = body.strip()
        if not text:
            return False

        fragment = Fragment(kind=kind, label=label, body=text)
        if fragment.digest in self._seen:
            # The same file, diff or command output twice in one investigation
            # teaches the model nothing and costs the same as the first copy.
            self.duplicates_skipped += 1
            return False

        if len(text) > self.budget.max_fragment_chars:
            fragment = Fragment(
                kind=kind,
                label=label,
                body=summarize_output(text, self.budget.max_fragment_chars),
            )
            self.fragments_truncated += 1

        rendered = len(fragment.render())
        if self._chars + rendered > self.budget.max_input_chars:
            self.fragments_dropped += 1
            logger.info("context budget reached; dropped %s %s", kind, label)
            return False

        self._seen.add(fragment.digest)
        self._fragments.append(fragment)
        self._chars += rendered
        return True

    def render(self) -> str:
        return "\n\n".join(f.render() for f in self._fragments)

    @property
    def estimated_tokens(self) -> int:
        return estimate_tokens(self.render())

    @property
    def fragment_count(self) -> int:
        return len(self._fragments)

    def stats(self) -> dict[str, int]:
        """Context accounting, surfaced so waste is visible rather than guessed."""
        return {
            "fragments": self.fragment_count,
            "estimatedTokens": self.estimated_tokens,
            "duplicatesSkipped": self.duplicates_skipped,
            "fragmentsTruncated": self.fragments_truncated,
            "fragmentsDropped": self.fragments_dropped,
        }


def summarize_output(text: str, max_chars: int) -> str:
    """Reduce long output to the lines that carry signal.

    Keeps the head and tail, and any line matching a security-relevant pattern,
    because those are what an investigation reasons about. The elision is
    marked so the model is never misled into thinking it saw everything.
    """
    if len(text) <= max_chars:
        return text

    lines = text.splitlines()
    if len(lines) <= 40:
        return text[: max_chars - 20] + "\n… [truncated]"

    head = lines[:15]
    tail = lines[-10:]
    middle = [line for line in lines[15:-10] if _SIGNAL.search(line)]

    omitted = len(lines) - len(head) - len(tail) - len(middle)
    body = [
        *head,
        f"… [{omitted} line(s) omitted; lines matching security-relevant patterns kept]",
        *middle[:40],
        *tail,
    ]
    joined = "\n".join(body)
    return joined if len(joined) <= max_chars else joined[: max_chars - 20] + "\n… [truncated]"


@dataclass(slots=True)
class DeterministicCache:
    """Content-addressed cache for model-independent analysis.

    Keyed by the content it was derived from, so a cache hit is only possible
    when the input is byte-identical. Model responses are never cached here;
    only facts that a rerun would recompute identically.
    """

    _entries: dict[str, object] = field(default_factory=dict)
    hits: int = 0
    misses: int = 0

    def key(self, *parts: str) -> str:
        return fingerprint("\x00".join(parts))

    def get(self, key: str) -> object | None:
        if key in self._entries:
            self.hits += 1
            return self._entries[key]
        self.misses += 1
        return None

    def put(self, key: str, value: object) -> None:
        self._entries[key] = value

    def stats(self) -> dict[str, int]:
        return {"cacheHits": self.hits, "cacheMisses": self.misses}


@dataclass(frozen=True, slots=True)
class PrefilterDecision:
    """Whether a model is worth invoking at all, decided deterministically."""

    needs_model: bool
    reason: str
    #: STANDARD for an ordinary finding; DEEP when the change looks complicated.
    suggested_tier: str = "STANDARD"


def prefilter(
    *,
    changed_file_count: int,
    secrets_introduced: int,
    exposure_paths: int,
    bundler_inlined: int,
) -> PrefilterDecision:
    """Decide whether model interpretation adds anything.

    Deterministic analysis already answers "is there an exposure?". The model is
    for explaining consequence to a reviewer, so it is only worth invoking when
    there is something to explain.
    """
    if secrets_introduced == 0 and exposure_paths == 0 and bundler_inlined == 0:
        return PrefilterDecision(
            needs_model=False,
            reason="deterministic analysis found no credential flow to interpret",
        )

    # A change that touches many files, or reaches a secret through several
    # routes, is where a reviewer most needs the consequence spelled out.
    complex_change = changed_file_count >= 8 or exposure_paths >= 4
    return PrefilterDecision(
        needs_model=True,
        reason="a credential flow was found and needs explaining to a reviewer",
        suggested_tier="DEEP" if complex_change else "STANDARD",
    )


__all__ = [
    "CHARS_PER_TOKEN",
    "ContextBudget",
    "ContextBuilder",
    "DeterministicCache",
    "Fragment",
    "PrefilterDecision",
    "estimate_tokens",
    "fingerprint",
    "prefilter",
    "summarize_output",
]
