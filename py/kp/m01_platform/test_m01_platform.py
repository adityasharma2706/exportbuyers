from __future__ import annotations

import pytest

from kp.m01_platform import KpError, assert_india_region, load_config, record_cost, uuid7
from kp.m01_platform import cost as cost_mod


def test_region_guard_accepts_india_only() -> None:
    assert assert_india_region("ap-south-1", "x") == "ap-south-1"
    assert assert_india_region("AP-SOUTH-2", "x") == "ap-south-2"
    for bad in ("us-east-1", "ap-southeast-1", "", None):
        with pytest.raises(KpError):
            assert_india_region(bad, "x")


def test_load_config_rejects_non_india_region() -> None:
    with pytest.raises(KpError):
        load_config({"APP_ENV": "test", "AWS_REGION": "eu-west-1"})
    with pytest.raises(KpError):
        load_config({"APP_ENV": "production", "AWS_REGION": "ap-south-1"})  # SECRETS_ID missing


def test_uuid7_is_version_7_and_monotonic() -> None:
    ids = [uuid7(1_700_000_000_000) for _ in range(50)]
    assert all(u.version == 7 for u in ids)
    assert ids == sorted(ids, key=lambda u: u.int)


def test_record_cost_validation_and_flush() -> None:
    written: list[object] = []
    cost_mod.set_cost_sink_for_testing(lambda rows: written.extend(rows))
    try:
        with pytest.raises(KpError):
            record_cost(vendor="Bad Vendor", op="x", units=1, cost_micros_inr=1)
        with pytest.raises(KpError):
            record_cost(vendor="openai", op="embed", units=1, cost_micros_inr=1.5)  # type: ignore[arg-type]
        record_cost(vendor="openai", op="embed", units=1000, cost_micros_inr=2500, job_type="kp.embed")
        cost_mod.flush_costs()
        assert len(written) == 1
        assert cost_mod.pending_cost_events() == 0
    finally:
        cost_mod.set_cost_sink_for_testing(None)
