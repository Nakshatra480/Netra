"""Token and context optimization.

Token efficiency is a product requirement, not a tuning detail: these tests
pin the behaviours that keep an investigation small.
"""

from netra_investigator.context.optimizer import (
    ContextBudget,
    ContextBuilder,
    DeterministicCache,
    estimate_tokens,
    prefilter,
    summarize_output,
)


class TestDeduplication:
    def test_the_same_fragment_is_never_sent_twice(self):
        builder = ContextBuilder()
        assert builder.add("file", "config.js", "const a = 1;")
        assert not builder.add("file", "config.js", "const a = 1;")
        assert builder.fragment_count == 1
        assert builder.stats()["duplicatesSkipped"] == 1

    def test_identical_content_under_a_different_label_is_still_a_duplicate(self):
        # The cost is in the bytes, not the label.
        builder = ContextBuilder()
        builder.add("file", "a.js", "same body")
        assert not builder.add("tool result", "read_file", "same body")

    def test_different_content_is_kept(self):
        builder = ContextBuilder()
        builder.add("file", "a.js", "one")
        builder.add("file", "b.js", "two")
        assert builder.fragment_count == 2

    def test_empty_fragments_are_ignored(self):
        builder = ContextBuilder()
        assert not builder.add("file", "a.js", "   \n ")
        assert builder.fragment_count == 0


class TestBudgets:
    def test_stops_adding_once_the_input_budget_is_reached(self):
        builder = ContextBuilder(budget=ContextBudget(max_input_tokens=100))
        # Distinct bodies, so refusals are budget decisions rather than
        # deduplication.
        added = [builder.add("file", f"f{i}.js", f"const v{i} = " + "x" * 300) for i in range(20)]

        assert not all(added), "the builder must refuse work beyond its budget"
        assert builder.stats()["duplicatesSkipped"] == 0
        assert builder.stats()["fragmentsDropped"] > 0
        assert builder.estimated_tokens <= 150

    def test_one_huge_file_cannot_crowd_out_everything(self):
        builder = ContextBuilder(
            budget=ContextBudget(max_input_tokens=10_000, max_fragment_tokens=100)
        )
        builder.add("file", "huge.js", "line\n" * 5_000)
        assert builder.stats()["fragmentsTruncated"] == 1
        # Room remains for the fragments that follow.
        assert builder.add("file", "small.js", "const a = 1;")

    def test_token_estimate_is_proportional_to_size(self):
        assert estimate_tokens("x" * 370) > estimate_tokens("x" * 37)


class TestSummarization:
    def test_short_output_is_left_alone(self):
        text = "line one\nline two"
        assert summarize_output(text, 1000) == text

    def test_long_output_keeps_security_relevant_lines(self):
        noise = "\n".join(f"unremarkable line {i}" for i in range(400))
        text = f"{noise}\nconst k = process.env.AWS_SECRET_ACCESS_KEY;\n{noise}"
        summary = summarize_output(text, 2000)

        # Never summarize away the thing the investigation is about.
        assert "AWS_SECRET_ACCESS_KEY" in summary
        assert len(summary) <= 2000

    def test_elision_is_marked_so_the_model_is_not_misled(self):
        text = "\n".join(f"line {i}" for i in range(500))
        summary = summarize_output(text, 500)
        assert "omitted" in summary or "truncated" in summary


class TestPrefilter:
    def test_no_model_call_when_there_is_nothing_to_interpret(self):
        decision = prefilter(
            changed_file_count=3,
            secrets_introduced=0,
            exposure_paths=0,
            bundler_inlined=0,
        )
        # The cheapest possible investigation: never contact a provider.
        assert not decision.needs_model
        assert "no credential flow" in decision.reason

    def test_a_model_is_invoked_when_a_flow_needs_explaining(self):
        decision = prefilter(
            changed_file_count=3,
            secrets_introduced=2,
            exposure_paths=2,
            bundler_inlined=1,
        )
        assert decision.needs_model
        assert decision.suggested_tier == "STANDARD"

    def test_a_complicated_change_escalates_to_the_deep_tier(self):
        decision = prefilter(
            changed_file_count=12,
            secrets_introduced=2,
            exposure_paths=6,
            bundler_inlined=1,
        )
        assert decision.suggested_tier == "DEEP"

    def test_the_strongest_model_is_not_the_default(self):
        # Escalation must be earned, or tiering saves nothing.
        ordinary = prefilter(
            changed_file_count=2, secrets_introduced=1, exposure_paths=1, bundler_inlined=1
        )
        assert ordinary.suggested_tier != "DEEP"


class TestCaching:
    def test_unchanged_content_is_not_recomputed(self):
        cache = DeterministicCache()
        key = cache.key("secret-flow", "abc123")

        assert cache.get(key) is None
        cache.put(key, {"exposed": True})
        assert cache.get(key) == {"exposed": True}
        assert cache.stats() == {"cacheHits": 1, "cacheMisses": 1}

    def test_different_content_gets_a_different_key(self):
        cache = DeterministicCache()
        assert cache.key("secret-flow", "abc") != cache.key("secret-flow", "def")
