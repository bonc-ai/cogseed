"""Candidate-local package validator entry point."""

from pathlib import Path

from ai_product_suite.validation.skill import validate_skill_package


def validate(package_root: Path):
    return validate_skill_package(package_root)
