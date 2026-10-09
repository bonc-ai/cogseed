"""Skill Declaration Core — CogSeed 声明准入引擎。

Public surface kept intentionally small and stable: the eight names below are
the compatibility API used by the CLI scripts and the engine's own conformance
runner. The platform adapter never imports this package directly — it only
probes this file's existence and speaks to the engine through the CLI contract.
"""

from .coherence import audit_coherence
from .completeness import audit_completeness
from .digesting import subject_digest, worktree_digest
from .freezing import audit_freeze_readiness, freeze_subject
from .registry import resolve_snapshot
from .trusting import derive_trust_posture

validate_completion = audit_completeness
derive_trust_controls = derive_trust_posture
validate_consistency = audit_coherence
compute_worktree_digest = worktree_digest
compute_subject_digest = subject_digest
check_freeze_readiness = audit_freeze_readiness
freeze_skill = freeze_subject
resolve_ontology = resolve_snapshot

__all__ = [
    "validate_completion",
    "derive_trust_controls",
    "validate_consistency",
    "compute_worktree_digest",
    "compute_subject_digest",
    "check_freeze_readiness",
    "freeze_skill",
    "resolve_ontology",
]

__version__ = "1.3.0"
