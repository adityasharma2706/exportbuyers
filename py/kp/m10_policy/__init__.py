"""M10 Global suppression list — Python client (IF-10c) for the knowledge plane.

Ingestion (M18/M20/M21/M22) and the evidence store (M09) check the list before writing:

- ``is_suppressed(kind, raw) -> bool``
- ``norm_hash(kind, raw) -> str``
- ``any_suppressed(hashes) -> set[str]``

The Visibility & Policy layer itself (IF-10a/b/d) lives in the TS serving plane
(``apps/web/src/modules/m10_policy``). Both languages share ``spec/normalisation``.
"""
from .client import any_suppressed, install_into_evidence_store, is_suppressed, set_connection_factory
from .normalise import IDENTIFIER_KINDS, hash_normalised, norm_hash, normalise
from .psl import registrable_domain, set_psl_rules_for_testing

__all__ = [
    "IDENTIFIER_KINDS",
    "any_suppressed",
    "hash_normalised",
    "install_into_evidence_store",
    "is_suppressed",
    "norm_hash",
    "normalise",
    "registrable_domain",
    "set_connection_factory",
    "set_psl_rules_for_testing",
]
