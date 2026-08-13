"""ECS Security Core — phase-1 shared engine."""

from .completion import validate_completion
from .consistency import validate_consistency
from .digest import compute_subject_digest, compute_worktree_digest
from .freeze import freeze_skill, check_freeze_readiness
from .trust import derive_trust_controls
from .version_resolver import resolve_ontology

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
