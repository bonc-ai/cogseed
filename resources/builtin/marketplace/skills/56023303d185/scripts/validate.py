"""Candidate-local package validator entry point."""

from pathlib import Path

from ai_product_suite.validation.meta import validate_meta_package


def validate(package_root: Path):
    return validate_meta_package(package_root)
