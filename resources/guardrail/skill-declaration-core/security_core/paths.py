"""Shared package paths and YAML/JSON loaders."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
ONTOLOGY_ROOT = PACKAGE_ROOT / "ontologies" / "ecs.security.skill"


def engine_version() -> str:
    version_file = PACKAGE_ROOT / "VERSION"
    return version_file.read_text(encoding="utf-8").strip()


def ontology_dir(version: str) -> Path:
    path = ONTOLOGY_ROOT / version
    if not path.is_dir():
        raise FileNotFoundError(f"Ontology snapshot not found: {version}")
    return path


@lru_cache(maxsize=32)
def load_yaml(path_str: str) -> Any:
    with open(path_str, encoding="utf-8") as f:
        return yaml.safe_load(f)


@lru_cache(maxsize=32)
def load_json(path_str: str) -> Any:
    with open(path_str, encoding="utf-8") as f:
        return json.load(f)


def load_ontology_artifact(version: str, name: str) -> Any:
    path = ontology_dir(version) / name
    if not path.exists():
        raise FileNotFoundError(path)
    if path.suffix == ".json":
        return load_json(str(path))
    return load_yaml(str(path))


def load_exit_code_registry() -> dict[str, Any]:
    return load_yaml(str(PACKAGE_ROOT / "exit-code-registry.yaml"))
