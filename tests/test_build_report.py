"""Unit tests for the FairRecorder merge / scoring core.

Run:
  <venv>/Scripts/python.exe -m unittest discover -s tests -v
  (or simply:  <venv>/Scripts/python.exe tests/test_build_report.py)
"""
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import fairlib as F  # noqa: E402


def supplier(**kw) -> dict:
    s = {
        "id": "s1", "source": "walk_in", "companyNameZh": "测试有限公司",
        "companyNameEn": "Test Co., Ltd.", "boothNo": "10.2B31", "contactName": "张三",
        "phone": "+86 13800000000", "categories": ["shower_enclosure"], "photoIds": ["p1"],
        "compliance": {c[0]: {"status": "unknown", "certNo": ""} for c in F.COMPLIANCE_ITEMS},
        "score": {}, "createdAt": "2026-10-23T10:00:00+08:00",
        "updatedAt": "2026-10-23T10:00:00+08:00", "deletedAt": None,
    }
    s.update(kw)
    return s


def make_zip(path: Path, suppliers, plans=None, photos=None, created="2026-10-23T18:00:00+08:00"):
    photos = photos or []
    bundle = {
        "schemaVersion": F.SCHEMA_VERSION,
        "export": {"id": "e1", "deviceId": "d1", "createdAt": created, "mode": "full",
                   "counts": {}, "weights": F.DEFAULT_WEIGHTS, "event": {}},
        "suppliers": suppliers, "visitPlans": plans or [],
        "photos": [{"id": p, "supplierId": "s1", "type": "product",
                    "path": f"photos/s1/{p}.jpg", "sha256": "", "size": 4,
                    "createdAt": created} for p in photos],
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("suppliers.json", json.dumps(bundle))
        for p in photos:
            z.writestr(f"photos/s1/{p}.jpg", b"\xff\xd8\xff\xd9")
    return path


class TestScoring(unittest.TestCase):
    def test_all_fives_is_one_hundred(self):
        s = supplier(score={d[0]: 5 for d in F.SCORE_DIMS})
        self.assertEqual(F.weighted_score(s, F.DEFAULT_WEIGHTS), 100.0)

    def test_all_ones_is_twenty(self):
        s = supplier(score={d[0]: 1 for d in F.SCORE_DIMS})
        self.assertEqual(F.weighted_score(s, F.DEFAULT_WEIGHTS), 20.0)

    def test_partial_scores_are_not_ranked(self):
        s = supplier(score={"fit": 5, "compliance": 5})
        self.assertIsNone(F.weighted_score(s, F.DEFAULT_WEIGHTS))

    def test_tiers(self):
        self.assertEqual(F.tier_of(85), "Shortlist")
        self.assertEqual(F.tier_of(72), "Follow-up")
        self.assertEqual(F.tier_of(65), "Reserve")
        self.assertEqual(F.tier_of(40), "Low priority")
        self.assertEqual(F.tier_of(None), "Not rated")


class TestState(unittest.TestCase):
    def test_draft_wins_over_rating(self):
        """A record missing mandatory fields must never be ranked."""
        s = supplier(photoIds=[], score={d[0]: 5 for d in F.SCORE_DIMS})
        self.assertEqual(F.state_of(s), "draft")

    def test_complete_without_scores(self):
        self.assertEqual(F.state_of(supplier()), "complete")

    def test_rated(self):
        self.assertEqual(F.state_of(supplier(score={d[0]: 4 for d in F.SCORE_DIMS})), "rated")

    def test_missing_fields_listed(self):
        m = F.missing_fields(supplier(contactName="", phone="", wechat="", email="", categories=[]))
        self.assertIn("联系人 / contact", m)
        self.assertIn("品类 / category", m)


class TestMerge(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.inbox = Path(self.tmp.name) / "inbox"
        self.inbox.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def _exports(self):
        issues: list[str] = []
        return F.load_exports(self.inbox, issues), issues

    def test_newest_revision_wins(self):
        old = supplier(boothNo="OLD", updatedAt="2026-10-23T10:00:00+08:00")
        new = supplier(boothNo="NEW", updatedAt="2026-10-24T10:00:00+08:00")
        make_zip(self.inbox / "a.zip", [old])
        make_zip(self.inbox / "b.zip", [new])
        exports, _ = self._exports()
        merged, _ = F.merge_suppliers(exports, [])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["boothNo"], "NEW")

    def test_tombstone_suppresses_record(self):
        live = supplier(updatedAt="2026-10-23T10:00:00+08:00")
        dead = supplier(updatedAt="2026-10-24T10:00:00+08:00", deletedAt="2026-10-24T10:00:00+08:00")
        make_zip(self.inbox / "a.zip", [live])
        make_zip(self.inbox / "b.zip", [dead])
        exports, _ = self._exports()
        merged, tombs = F.merge_suppliers(exports, [])
        self.assertEqual(merged, [])
        self.assertEqual(len(tombs), 1)

    def test_corrupt_zip_is_reported_not_fatal(self):
        (self.inbox / "broken.zip").write_bytes(b"not a zip at all")
        exports, issues = self._exports()
        self.assertEqual(exports, [])
        self.assertTrue(any("not a readable ZIP" in i for i in issues))

    def test_unsafe_member_names_are_flagged(self):
        zpath = self.inbox / "weird.zip"
        with zipfile.ZipFile(zpath, "w") as z:
            z.writestr("suppliers.json", json.dumps({"schemaVersion": 1, "suppliers": [], "visitPlans": [], "photos": []}))
            z.writestr("../../escape.txt", "x")
        exports, issues = self._exports()
        self.assertEqual(len(exports), 1)
        self.assertTrue(any("unsafe paths" in i for i in issues))


class TestDedupe(unittest.TestCase):
    def test_same_company_booth_and_contact_merges(self):
        a = supplier(id="a", phone="+86 13800000000", photoIds=["p1"], createdAt="2026-10-23T09:00:00+08:00")
        b = supplier(id="b", phone="+86 13800000000", photoIds=["p2"], createdAt="2026-10-23T11:00:00+08:00")
        keep, cands = F.dedupe_business([a, b], [])
        self.assertEqual(len(keep), 1)
        self.assertEqual(cands, [])
        self.assertEqual(sorted(keep[0]["photoIds"]), ["p1", "p2"])

    def test_differing_contact_is_only_a_candidate(self):
        a = supplier(id="a", phone="+86 13800000000")
        b = supplier(id="b", phone="+86 13900000000")
        keep, cands = F.dedupe_business([a, b], [])
        self.assertEqual(len(keep), 2)
        self.assertEqual(len(cands), 1)


class TestComparability(unittest.TestCase):
    def test_mixed_currency_is_not_comparable(self):
        a = supplier(currency="USD", incoterm="FOB", priceUnit="set", priceMin=100)
        b = supplier(id="s2", currency="CNY", incoterm="EXW", priceUnit="m²", priceMin=95)
        keys = {F.price_key(a), F.price_key(b)}
        self.assertGreater(len(keys), 1)

    def test_price_text(self):
        s = supplier(currency="USD", priceMin=180, priceMax=260, incoterm="FOB", priceUnit="set")
        self.assertIn("USD 180–260", F.price_text(s))
        self.assertIn("FOB", F.price_text(s))


if __name__ == "__main__":
    unittest.main(verbosity=2)
