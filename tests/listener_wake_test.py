"""Unit tests for the pure wake-phrase helpers in listener/listener.py.

listener.py imports numpy/sounddevice at module load for the audio loop, but the
wake-phrase logic (normalize_text, levenshtein_distance, get_wake_variants,
fuzzy_matches_wake, detect_wake_phrase, ...) is pure and deterministic. We stub
the heavy audio deps so the module imports without hardware, then lock down the
routing-critical behaviour the repo depends on:

  * "PK" exactly wakes with no command,
  * "PK one" / "PK two" keep the compact numeric route as the command,
  * multi-word commands are preserved (not collapsed),
  * fuzzy + compact matching follow PI_SPEAK_WAKE_SENSITIVITY.

Run directly (python3 tests/listener_wake_test.py) or via tests/listener-wake.test.mjs.
"""

from __future__ import annotations

import os
import sys
import types
import unittest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(TESTS_DIR)
LISTENER_DIR = os.path.join(REPO_ROOT, "listener")

# Stub optional native deps so the pure helpers import without audio hardware.
# `from __future__ import annotations` in listener.py keeps np.ndarray hints as
# strings, so empty module stubs are sufficient for import.
for _name in ("numpy", "sounddevice"):
    if _name not in sys.modules:
        sys.modules[_name] = types.ModuleType(_name)

if LISTENER_DIR not in sys.path:
    sys.path.insert(0, LISTENER_DIR)

import listener  # noqa: E402

# Env vars that override wake behaviour; cleared before each test for determinism.
_WAKE_ENV_KEYS = (
    "PI_SPEAK_WAKE_FUZZY_ENABLED",
    "PI_SPEAK_WAKE_COMPACT_PREFIX_ENABLED",
    "PI_SPEAK_WAKE_FUZZY_MAX_DISTANCE",
)


class WakePhraseTestBase(unittest.TestCase):
    def setUp(self):
        for key in _WAKE_ENV_KEYS:
            os.environ.pop(key, None)
        # Reset module state to the documented defaults: wake phrase "PK",
        # medium sensitivity, and cleared variant caches.
        listener.WAKE_PHRASE_DISPLAY = "PK"
        listener.WAKE_SENSITIVITY = "medium"
        listener._wakeup_variants = None
        listener._wakeup_compact_variants = None


class NormalizeAndCompactTests(WakePhraseTestBase):
    def test_normalize_lowercases_and_strips_punctuation(self):
        self.assertEqual(listener.normalize_text("Hello, World!"), "hello world")

    def test_normalize_collapses_whitespace(self):
        self.assertEqual(listener.normalize_text("  PK   one  "), "pk one")

    def test_normalize_keeps_word_chars_hyphen_underscore(self):
        self.assertEqual(listener.normalize_text("foo_bar-baz"), "foo_bar-baz")

    def test_normalize_treats_dots_as_separators(self):
        self.assertEqual(listener.normalize_text("p.k."), "p k")

    def test_compact_removes_spaces(self):
        self.assertEqual(listener.compact_text("p k one"), "pkone")


class LevenshteinTests(WakePhraseTestBase):
    def test_identical_strings(self):
        self.assertEqual(listener.levenshtein_distance("pk", "pk"), 0)

    def test_empty_operand(self):
        self.assertEqual(listener.levenshtein_distance("", "abc"), 3)
        self.assertEqual(listener.levenshtein_distance("abc", ""), 3)

    def test_classic_example(self):
        self.assertEqual(listener.levenshtein_distance("kitten", "sitting"), 3)

    def test_single_substitution(self):
        self.assertEqual(listener.levenshtein_distance("pk", "pj"), 1)


class WakeVariantTests(WakePhraseTestBase):
    def test_pk_expands_to_spoken_variants(self):
        variants = listener.get_wake_variants()
        self.assertEqual(variants[0], "pk")
        for spoken in ("pee kay", "okay pk", "ok pk"):
            self.assertIn(spoken, variants)

    def test_variants_are_deduped(self):
        variants = listener.get_wake_variants()
        self.assertEqual(len(variants), len(set(variants)))

    def test_compact_variants_strip_spaces(self):
        compact = listener.get_wake_compact_variants()
        self.assertIn("pk", compact)
        self.assertIn("peekay", compact)
        self.assertIn("okaypk", compact)

    def test_custom_wake_phrase_has_no_pk_aliases(self):
        listener.WAKE_PHRASE_DISPLAY = "computer"
        listener._wakeup_variants = None
        listener._wakeup_compact_variants = None
        self.assertEqual(listener.get_wake_variants(), ("computer",))


class DetectWakePhraseTests(WakePhraseTestBase):
    def test_exact_phrase_wakes_with_empty_command(self):
        self.assertEqual(listener.detect_wake_phrase("PK"), "")

    def test_prefix_returns_trailing_command(self):
        self.assertEqual(listener.detect_wake_phrase("PK open the door"), "open the door")

    def test_compact_numeric_routes_are_preserved(self):
        # The repo contract: "one"/"two" must stay distinct, deterministic routes.
        self.assertEqual(listener.detect_wake_phrase("PK one"), "one")
        self.assertEqual(listener.detect_wake_phrase("PK two"), "two")

    def test_multi_word_target_is_not_collapsed(self):
        # "to Google" must survive intact, not get mangled into a numeric route.
        self.assertEqual(listener.detect_wake_phrase("PK route to Google"), "route to google")

    def test_spoken_variant_prefix(self):
        self.assertEqual(listener.detect_wake_phrase("pee kay status"), "status")

    def test_compact_prefix_without_space_medium(self):
        # Medium sensitivity enables compact-prefix matching, so "pkone" -> "one".
        self.assertEqual(listener.detect_wake_phrase("pkone"), "one")

    def test_non_wake_input_returns_none(self):
        self.assertIsNone(listener.detect_wake_phrase("open google please"))
        self.assertIsNone(listener.detect_wake_phrase(""))


class SensitivityTests(WakePhraseTestBase):
    def test_medium_enables_fuzzy_matching(self):
        listener.WAKE_SENSITIVITY = "medium"
        self.assertTrue(listener.get_wake_fuzzy_enabled())
        # One-edit slip of "pk" should still wake at distance 1.
        self.assertTrue(listener.fuzzy_matches_wake("pj"))
        self.assertEqual(listener.detect_wake_phrase("pj one"), "one")

    def test_low_disables_fuzzy_and_compact_prefix(self):
        listener.WAKE_SENSITIVITY = "low"
        self.assertFalse(listener.get_wake_fuzzy_enabled())
        self.assertFalse(listener.get_wake_compact_prefix_enabled())
        self.assertEqual(listener.get_wake_fuzzy_max_distance(), 0)
        # Without fuzzy/compact help, a slurred or space-less wake should miss.
        self.assertFalse(listener.fuzzy_matches_wake("pj"))
        self.assertIsNone(listener.detect_wake_phrase("pkone"))
        # Exact phrasing still works at low sensitivity.
        self.assertEqual(listener.detect_wake_phrase("PK one"), "one")

    def test_high_widens_fuzzy_distance(self):
        listener.WAKE_SENSITIVITY = "high"
        self.assertEqual(listener.get_wake_fuzzy_max_distance(), 2)

    def test_env_override_forces_fuzzy_distance(self):
        listener.WAKE_SENSITIVITY = "low"
        os.environ["PI_SPEAK_WAKE_FUZZY_MAX_DISTANCE"] = "3"
        self.assertEqual(listener.get_wake_fuzzy_max_distance(), 3)

    def test_env_override_can_force_fuzzy_on(self):
        listener.WAKE_SENSITIVITY = "low"
        os.environ["PI_SPEAK_WAKE_FUZZY_ENABLED"] = "1"
        self.assertTrue(listener.get_wake_fuzzy_enabled())


if __name__ == "__main__":
    unittest.main(verbosity=2)
