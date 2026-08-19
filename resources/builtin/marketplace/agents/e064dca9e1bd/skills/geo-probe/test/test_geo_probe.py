"""Unit tests for geo-probe query-gen + answer scoring. stdlib unittest."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from geo_probe import (  # noqa: E402
    context_terms, derive_brand_domain, gen_queries, score_answers, _mentions,
)


def crawl(title, h1s, sd=None, url="https://cogseed.ai/"):
    return {"ok": True, "data": {"site": {}, "pages": [
        {"url": url, "title": title, "h1s": h1s, "structured_data": sd or []}]}}


class QueriesTest(unittest.TestCase):
    def test_brand_from_org_schema(self):
        c = crawl("Home | Acme", ["Welcome"],
                  sd=[{"@type": "Organization", "name": "CogSeed", "url": "https://cogseed.ai"}])
        brand, domain = derive_brand_domain(c, None, None)
        self.assertEqual(brand, "CogSeed")
        self.assertEqual(domain, "cogseed.ai")

    def test_brand_from_title_when_no_schema(self):
        brand, domain = derive_brand_domain(crawl("CogSeed — AI desktop client", ["CogSeed"]), None, None)
        self.assertEqual(brand, "CogSeed")

    def test_queries_include_what_is_and_alternatives(self):
        qs = gen_queries(crawl("CogSeed AI agents", ["CogSeed multi-agent desktop"]), "CogSeed", [])
        self.assertIn("What is CogSeed?", qs)
        self.assertTrue(any("alternatives" in q for q in qs))

    def test_competitor_vs_query(self):
        qs = gen_queries(crawl("CogSeed", ["CogSeed"]), "CogSeed", ["Cursor"])
        self.assertTrue(any("vs Cursor" in q for q in qs))


class ScoreTest(unittest.TestCase):
    def test_sov_and_citation(self):
        payload = {"brand": "CogSeed", "domain": "cogseed.ai", "competitors": ["Cursor"], "answers": [
            {"query": "what is cogseed", "mode": "retrieval", "text": "CogSeed is a desktop client, see cogseed.ai."},
            {"query": "best tools", "mode": "param", "text": "Cursor and others are popular."},
            {"query": "alternatives", "mode": "param", "text": "CogSeed is one option."},
        ]}
        r = score_answers(payload)
        self.assertAlmostEqual(r["share_of_voice"], 0.667, places=2)  # 2/3 mention CogSeed
        self.assertAlmostEqual(r["citation_rate"], 0.333, places=2)   # 1/3 cite cogseed.ai
        self.assertEqual(r["competitor_share"]["Cursor"], round(1 / 3, 3))
        self.assertEqual(r["data_tier"], "Estimated")  # not all retrieval

    def test_all_retrieval_is_measured(self):
        payload = {"brand": "CogSeed", "domain": "cogseed.ai", "answers": [
            {"mode": "retrieval", "text": "CogSeed (cogseed.ai) is great."}]}
        self.assertEqual(score_answers(payload)["data_tier"], "Measured")

    def test_empty_answers_raises(self):
        with self.assertRaises(ValueError):
            score_answers({"brand": "X", "answers": []})


class DisambiguationTest(unittest.TestCase):
    def test_context_excludes_homonym(self):
        payload = {"brand": "CogSeed", "domain": "cogseed.ai",
                   "context_terms": ["ai", "agent", "desktop"], "answers": [
                       {"text": "CogSeed are killer whales in the ocean.", "mode": "param"},   # ambiguous
                       {"text": "CogSeed is an AI agent desktop client.", "mode": "param"},     # mentioned
                       {"text": "See cogseed.ai for the CogSeed app.", "mode": "param"},          # cited
                       {"text": "Cursor is popular.", "mode": "param"},                       # absent
                   ]}
        r = score_answers(payload)
        self.assertEqual([x["result"] for x in r["per_answer"]],
                         ["ambiguous", "mentioned", "cited", "absent"])
        self.assertEqual(r["share_of_voice"], 0.5)     # (cited + mentioned) / 4
        self.assertEqual(r["citation_rate"], 0.25)
        self.assertEqual(r["ambiguous_mentions"], 1)
        self.assertEqual(r["brand_mentions"], 2)

    def test_legacy_without_context_terms(self):
        # No context_terms -> any brand token counts (back-compat with old behavior).
        r = score_answers({"brand": "CogSeed", "domain": "cogseed.ai",
                           "answers": [{"text": "CogSeed are whales.", "mode": "param"}]})
        self.assertEqual(r["share_of_voice"], 1.0)
        self.assertEqual(r["ambiguous_mentions"], 0)

    def test_context_word_boundary_not_substring(self):
        # 'ai' must not corroborate via 'said'/'maintain'; this answer has no real context term.
        r = score_answers({"brand": "CogSeed", "domain": "cogseed.ai", "context_terms": ["ai"],
                           "answers": [{"text": "He said CogSeed swims and maintains speed.", "mode": "param"}]})
        self.assertEqual(r["per_answer"][0]["result"], "ambiguous")

    def test_queries_op_emits_context_terms(self):
        c = crawl("CogSeed — Open-Source Multi-Agent AI Desktop Client", ["CogSeed multi-agent desktop"])
        terms = context_terms(c, "CogSeed", "cogseed.ai")
        self.assertIn("desktop", terms)
        self.assertNotIn("cogseed", terms)  # brand token excluded


class MentionTest(unittest.TestCase):
    def test_word_boundary(self):
        self.assertTrue(_mentions("I use CogSeed daily", "CogSeed"))
        self.assertFalse(_mentions("Xenon is an element", "X"))  # no substring false-positive


class CompetitorShareTest(unittest.TestCase):
    def test_competitor_share_word_boundary(self):
        # "Cline" hides inside "decline"/"inclined"; regex word-boundary must reject it.
        neg = score_answers({"brand": "CogSeed", "domain": "cogseed.ai", "competitors": ["Cline"],
                             "answers": [{"text": "Sales decline; inclined to wait.", "mode": "param"}]})
        self.assertEqual(neg["competitor_share"]["Cline"], 0.0)
        # Positive control: a real standalone token counts.
        pos = score_answers({"brand": "CogSeed", "domain": "cogseed.ai", "competitors": ["Cline"],
                             "answers": [{"text": "I tried Cline yesterday.", "mode": "param"}]})
        self.assertEqual(pos["competitor_share"]["Cline"], 1.0)


class ModeTierTest(unittest.TestCase):
    def test_mode_case_insensitive_tier(self):
        # mode is lowercased: a single "Retrieval" answer -> Measured tier.
        r = score_answers({"brand": "CogSeed", "domain": "cogseed.ai",
                           "answers": [{"text": "CogSeed is great.", "mode": "Retrieval"}]})
        self.assertEqual(r["data_tier"], "Measured")
        self.assertEqual(r["per_answer"][0]["mode"], "retrieval")
        # Omitted mode key defaults to param -> Estimated tier.
        r2 = score_answers({"brand": "CogSeed", "domain": "cogseed.ai",
                            "answers": [{"text": "CogSeed is great."}]})
        self.assertEqual(r2["data_tier"], "Estimated")
        self.assertEqual(r2["per_answer"][0]["mode"], "param")


class DomainCitationBoundaryTest(unittest.TestCase):
    def test_domain_substring_is_not_a_citation(self):
        # A domain that merely prefixes a longer host must NOT count as cited.
        # Brand "Globex" is absent so this isolates the domain-citation rule.
        r = score_answers({"brand": "Globex", "domain": "cogseed.ai",
                           "answers": [{"text": "Book flights at cogseed.airlines.com today.",
                                        "mode": "retrieval"}]})
        self.assertFalse(r["per_answer"][0]["domain_cited"])
        self.assertEqual(r["per_answer"][0]["result"], "absent")
        self.assertEqual(r["citation_rate"], 0.0)

    def test_real_domain_citation_still_counts(self):
        # Path/boundary-adjacent forms remain genuine citations.
        r = score_answers({"brand": "CogSeed", "domain": "cogseed.ai",
                           "answers": [{"text": "See cogseed.ai/docs for setup.", "mode": "retrieval"}]})
        self.assertEqual(r["per_answer"][0]["result"], "cited")
        self.assertTrue(r["per_answer"][0]["domain_cited"])
        self.assertEqual(r["citation_rate"], 1.0)


if __name__ == "__main__":
    unittest.main()
