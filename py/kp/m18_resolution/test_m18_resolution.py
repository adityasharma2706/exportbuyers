"""M18 tests over the in-memory evidence repo."""
from __future__ import annotations

from typing import Any, Iterator

import pytest

from kp.m09_evidence import MemoryEvidenceRepo, find_by_anchor, merge_companies, set_suppression_checker
from kp.m10_policy import norm_hash, set_psl_rules_for_testing
from kp.m18_resolution import (
    FILE_MERGE_REVIEW_JOB,
    Candidate,
    is_excluded_anchor_domain,
    memory_backends,
    normalise_city,
    resolve,
    trigram_similarity,
)


@pytest.fixture(autouse=True)
def _isolated() -> Iterator[None]:
    set_suppression_checker(None)
    set_psl_rules_for_testing("com\nuk\nco.uk\nde\nae\n")
    yield
    set_psl_rules_for_testing(None)


def cand(**kw: Any) -> Candidate:
    base: dict[str, Any] = {"name": "Acme Trading Ltd", "country": "GB", "source_id": "test.source"}
    base.update(kw)
    return Candidate.model_validate(base)


def review_jobs(repo: MemoryEvidenceRepo) -> list[dict[str, Any]]:
    _, outbox = memory_backends(repo)
    return [j["payload"] for (t, _), j in outbox.jobs.items() if t == FILE_MERGE_REVIEW_JOB]


def test_trigram_similarity_matches_pg_trgm() -> None:
    assert trigram_similarity("acme", "acme") == 1.0
    assert trigram_similarity("abc", "abd") == pytest.approx(2 / 6)
    assert trigram_similarity("", "abc") == 0.0


def test_new_company_then_anchor_match_by_lei() -> None:
    repo = MemoryEvidenceRepo()
    r1 = resolve(cand(lei="5493 00ABCDEF1234 5678"), tx=repo)
    assert r1.method == "new" and r1.created and r1.company_id is not None
    r2 = resolve(cand(name="Totally Different Name", lei="549300ABCDEF12345678"), tx=repo)
    assert r2.method == "anchor" and r2.confidence == 1.0 and not r2.created
    assert r2.company_id == r1.company_id


def test_suppressed_domain_is_dropped_without_writes() -> None:
    repo = MemoryEvidenceRepo()
    repo.suppression.add(norm_hash("domain", "acme.co.uk"))
    r = resolve(cand(domain="https://www.acme.co.uk/about"), tx=repo)
    assert r.method == "suppressed" and r.company_id is None and not r.created
    assert repo.companies == {}


def test_suppressed_registry_is_dropped() -> None:
    repo = MemoryEvidenceRepo()
    repo.suppression.add(norm_hash("registry", "GB:ch:01234567"))
    r = resolve(cand(registry_ids=["gb:CH:0123-4567"]), tx=repo)
    assert r.method == "suppressed" and repo.companies == {}


def test_matched_company_whose_id_is_suppressed_is_not_resurrected() -> None:
    repo = MemoryEvidenceRepo()
    first = resolve(cand(vat="GB123456789"), tx=repo)
    repo.suppression.add(norm_hash("company_id", str(first.company_id)))
    again = resolve(cand(vat="GB 123 456 789"), tx=repo)
    assert again.method == "suppressed" and again.company_id is None


def test_fuzzy_match_above_threshold() -> None:
    repo = MemoryEvidenceRepo()
    first = resolve(cand(city="London", address="12 Baker Street, Marylebone"), tx=repo)
    second = resolve(cand(name="ACME Trading Limited", city="london", address="12 Baker St Marylebone"), tx=repo)
    assert second.method == "fuzzy" and second.company_id == first.company_id
    assert second.confidence >= 0.92
    assert review_jobs(repo) == []


def test_review_band_creates_new_company_and_files_review() -> None:
    repo = MemoryEvidenceRepo()
    first = resolve(cand(city="London", address="12 Baker Street"), tx=repo)
    second = resolve(cand(name="Acme Trading", city="London"), tx=repo)   # 0.6 + 0.2 + 0 = 0.80
    assert second.method == "review" and second.created
    assert second.company_id != first.company_id
    jobs = review_jobs(repo)
    assert len(jobs) == 1
    assert jobs[0]["a"] == str(first.company_id) and jobs[0]["b"] == str(second.company_id)
    assert jobs[0]["reason"] == "fuzzy" and jobs[0]["score"] == pytest.approx(0.8)


def test_below_review_band_is_new_without_review() -> None:
    repo = MemoryEvidenceRepo()
    resolve(cand(city="London"), tx=repo)
    r = resolve(cand(name="Acme Trading", city="Leeds"), tx=repo)   # 0.6
    assert r.method == "new" and review_jobs(repo) == []


def test_other_country_is_never_a_fuzzy_candidate() -> None:
    repo = MemoryEvidenceRepo()
    a = resolve(cand(city="London", address="1 High Street"), tx=repo)
    b = resolve(cand(country="DE", city="London", address="1 High Street"), tx=repo)
    assert b.method == "new" and b.company_id != a.company_id


def test_conflicting_anchors_file_review_and_keep_lei_match() -> None:
    repo = MemoryEvidenceRepo()
    by_lei = resolve(cand(name="Alpha Imports", lei="LEI00000000000000001"), tx=repo)
    by_domain = resolve(cand(name="Beta Foods", domain="beta.com"), tx=repo)
    r = resolve(cand(name="Gamma", lei="LEI00000000000000001", domain="beta.com"), tx=repo)
    assert r.method == "anchor" and r.company_id == by_lei.company_id
    jobs = review_jobs(repo)
    assert len(jobs) == 1
    assert jobs[0]["reason"] == "anchor_conflict"
    assert jobs[0]["a"] == str(by_lei.company_id) and jobs[0]["b"] == str(by_domain.company_id)
    # The domain stays with the company that already holds it.
    assert find_by_anchor("domain", "beta.com", tx=repo) == str(by_domain.company_id)


def test_decided_pair_is_not_filed_again() -> None:
    repo = MemoryEvidenceRepo()
    a = resolve(cand(name="Alpha Imports", lei="LEI00000000000000001"), tx=repo)
    b = resolve(cand(name="Beta Foods", domain="beta.com"), tx=repo)
    repo.record_merge_decision(str(a.company_id), str(b.company_id), "distinct", None, "admin:x")
    resolve(cand(name="Gamma", lei="LEI00000000000000001", domain="beta.com"), tx=repo)
    assert review_jobs(repo) == []


def test_free_mail_domain_is_not_an_anchor() -> None:
    assert is_excluded_anchor_domain("gmail.com")
    assert not is_excluded_anchor_domain("acme.co.uk")
    repo = MemoryEvidenceRepo()
    a = resolve(cand(name="North Star Traders", domain="gmail.com"), tx=repo)
    b = resolve(cand(name="Southern Cross Metals", domain="gmail.com"), tx=repo)
    assert a.method == "new" and b.method == "new" and a.company_id != b.company_id
    assert find_by_anchor("domain", "gmail.com", tx=repo) is None


def test_free_anchors_are_attached_on_match() -> None:
    repo = MemoryEvidenceRepo()
    first = resolve(cand(lei="LEI00000000000000009"), tx=repo)
    resolve(cand(lei="LEI00000000000000009", domain="acme.co.uk"), tx=repo)
    assert find_by_anchor("domain", "acme.co.uk", tx=repo) == str(first.company_id)


def test_merged_company_resolves_to_survivor_and_is_not_a_fuzzy_candidate() -> None:
    repo = MemoryEvidenceRepo()
    keep = resolve(cand(name="Keep Co", lei="LEI00000000000000011"), tx=repo)
    gone = resolve(cand(name="Gone Company", city="Paris", address="3 Rue X", vat="FR999"), tx=repo)
    merge_companies(repo, str(keep.company_id), str(gone.company_id))
    via_anchor = resolve(cand(name="Anything", vat="FR999"), tx=repo)
    assert via_anchor.company_id == keep.company_id
    fuzzy = resolve(cand(name="Gone Company", city="Paris", address="3 Rue X"), tx=repo)
    assert fuzzy.company_id not in (gone.company_id,)


def test_city_aliases() -> None:
    assert normalise_city("St. Petersburg") == normalise_city("Saint Petersburg")
    assert normalise_city("  ") is None


def test_blank_name_is_rejected() -> None:
    from kp.m01_platform import KpError

    with pytest.raises(KpError):
        resolve(cand(name="!!!"), tx=MemoryEvidenceRepo())
