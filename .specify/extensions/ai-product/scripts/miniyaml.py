"""A deliberately small YAML subset loader for offline candidate validation.

It supports the manifest/record subset used by this package: indentation-based
mappings and sequences, quoted/bare scalars, booleans, null, numbers, and inline
lists. It is not a replacement for a general YAML implementation; native Spec
Kit remains the authoritative parser for component manifests.
"""

from __future__ import annotations

import ast
import json
import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Line:
    indent: int
    text: str
    number: int


def load(text: str) -> Any:
    stripped = text.lstrip()
    if stripped.startswith(("{", "[")):
        return json.loads(text)
    lines: list[Line] = []
    for number, raw in enumerate(text.splitlines(), 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if "\t" in raw[: len(raw) - len(raw.lstrip())]:
            raise ValueError(f"line {number}: tabs are not supported")
        indent = len(raw) - len(raw.lstrip(" "))
        lines.append(Line(indent, raw.strip(), number))
    if not lines:
        return None
    value, index = _parse_block(lines, 0, lines[0].indent)
    if index != len(lines):
        raise ValueError(f"line {lines[index].number}: unexpected content")
    return value


def _parse_block(lines: list[Line], index: int, indent: int) -> tuple[Any, int]:
    if index >= len(lines) or lines[index].indent < indent:
        return None, index
    if lines[index].indent != indent:
        raise ValueError(f"line {lines[index].number}: unexpected indentation")
    if lines[index].text.startswith("- ") or lines[index].text == "-":
        return _parse_sequence(lines, index, indent)
    return _parse_mapping(lines, index, indent)


def _parse_mapping(lines: list[Line], index: int, indent: int) -> tuple[dict[str, Any], int]:
    result: dict[str, Any] = {}
    while index < len(lines):
        line = lines[index]
        if line.indent < indent:
            break
        if line.indent > indent:
            raise ValueError(f"line {line.number}: unexpected indentation")
        if line.text.startswith("- "):
            break
        key, rest = _split_key_value(line)
        if key in result:
            raise ValueError(f"line {line.number}: duplicate key {key!r}")
        index += 1
        if rest == "":
            if index < len(lines) and lines[index].indent > indent:
                value, index = _parse_block(lines, index, lines[index].indent)
            else:
                value = None
        else:
            value = _parse_scalar(rest, line.number)
        result[key] = value
    return result, index


def _parse_sequence(lines: list[Line], index: int, indent: int) -> tuple[list[Any], int]:
    result: list[Any] = []
    while index < len(lines):
        line = lines[index]
        if line.indent < indent:
            break
        if line.indent != indent or not (line.text.startswith("- ") or line.text == "-"):
            break
        item_text = line.text[1:].strip()
        index += 1
        if item_text == "":
            if index < len(lines) and lines[index].indent > indent:
                item, index = _parse_block(lines, index, lines[index].indent)
            else:
                item = None
            result.append(item)
            continue

        if _looks_like_mapping_item(item_text):
            key, rest = _split_key_value(Line(indent + 2, item_text, line.number))
            item_map: dict[str, Any] = {key: _parse_scalar(rest, line.number) if rest else None}
            if index < len(lines) and lines[index].indent > indent:
                continuation, index = _parse_block(lines, index, lines[index].indent)
                if not isinstance(continuation, dict):
                    if rest:
                        raise ValueError(f"line {line.number}: mapping item has non-mapping continuation")
                    item_map[key] = continuation
                else:
                    if rest == "" and key in continuation:
                        raise ValueError(f"line {line.number}: ambiguous nested mapping")
                    item_map.update(continuation)
            result.append(item_map)
        else:
            item = _parse_scalar(item_text, line.number)
            if index < len(lines) and lines[index].indent > indent:
                raise ValueError(f"line {lines[index].number}: scalar sequence item cannot have children")
            result.append(item)
    return result, index


def _split_key_value(line: Line) -> tuple[str, str]:
    quote: str | None = None
    for index, char in enumerate(line.text):
        if char in {"'", '"'}:
            if quote is None:
                quote = char
            elif quote == char:
                quote = None
        elif char == ":" and quote is None:
            key = line.text[:index].strip()
            if not key:
                break
            return _unquote(key), line.text[index + 1 :].strip()
    raise ValueError(f"line {line.number}: expected key: value")


def _looks_like_mapping_item(text: str) -> bool:
    try:
        _split_key_value(Line(0, text, 0))
        return True
    except ValueError:
        return False


def _parse_scalar(text: str, number: int) -> Any:
    if text in {"null", "Null", "NULL", "~"}:
        return None
    if text.lower() in {"true", "false"}:
        return text.lower() == "true"
    if text == "[]":
        return []
    if text == "{}":
        return {}
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        if not inner:
            return []
        return [_parse_scalar(part.strip(), number) for part in _split_inline(inner)]
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        try:
            return ast.literal_eval(text)
        except (SyntaxError, ValueError) as exc:
            raise ValueError(f"line {number}: invalid quoted scalar") from exc
    if re.fullmatch(r"[-+]?\d+", text):
        return int(text)
    if re.fullmatch(r"[-+]?(?:\d+\.\d*|\d*\.\d+)", text):
        return float(text)
    return text


def _split_inline(text: str) -> list[str]:
    result: list[str] = []
    start = 0
    quote: str | None = None
    depth = 0
    for index, char in enumerate(text):
        if char in {"'", '"'}:
            if quote is None:
                quote = char
            elif quote == char:
                quote = None
        elif quote is None:
            if char in "[{":
                depth += 1
            elif char in "]}":
                depth -= 1
            elif char == "," and depth == 0:
                result.append(text[start:index])
                start = index + 1
    result.append(text[start:])
    return result


def _unquote(value: str) -> str:
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return str(ast.literal_eval(value))
    return value
