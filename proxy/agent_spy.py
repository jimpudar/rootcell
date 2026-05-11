#!/usr/bin/env python3
"""Bedrock traffic capture and formatting helpers for the firewall VM.

This module is intentionally stdlib-only. mitmproxy imports the capture
helpers from its own Python environment, while `./rootcell spy` runs the same
file as a CLI inside the firewall VM to tail and format captured events.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import datetime as _dt
import fnmatch
import hashlib
import json
import os
import re
import struct
import sys
import time
import urllib.parse
from typing import Any, Iterable


SPY_DIR = os.environ.get("AGENT_SPY_DIR", "/run/agent-vm-spy")
SPY_ENABLED = os.path.join(SPY_DIR, "enabled")
SPY_EVENTS = os.path.join(SPY_DIR, "events.ndjson")

EVENTSTREAM_CONTENT_TYPE = "application/vnd.amazon.eventstream"
JSON_CONTENT_TYPES = {
    "application/json",
    "application/x-amz-json-1.0",
    "application/x-amz-json-1.1",
}

BEDROCK_OPERATIONS = {
    "invoke",
    "invoke-with-response-stream",
    "converse",
    "converse-stream",
}

SECRET_HEADER_NAMES = {
    "authorization",
    "proxy-authorization",
    "x-amz-security-token",
    "x-amz-credential",
    "x-amz-signature",
    "x-api-key",
    "api-key",
}

INTERESTING_HEADER_NAMES = {
    "accept",
    "content-type",
    "user-agent",
    "x-amzn-bedrock-accept",
    "x-amzn-bedrock-performanceconfig-latency",
    "x-amzn-bedrock-trace",
    "x-amzn-requestid",
    "x-amz-date",
    "x-amz-content-sha256",
    "x-amz-target",
}

PRESIGNED_QUERY_KEYS = {
    "authorization",
    "x-amz-credential",
    "x-amz-signature",
    "x-amz-security-token",
    "awsaccesskeyid",
    "signature",
    "security-token",
}


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_json(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return _sha256_bytes(encoded)


def _content_type_base(value: str | None) -> str:
    if not value:
        return ""
    return value.split(";", 1)[0].strip().lower()


def _is_json_content_type(value: str | None) -> bool:
    return _content_type_base(value) in JSON_CONTENT_TYPES


def _is_eventstream_content_type(value: str | None) -> bool:
    return _content_type_base(value) == EVENTSTREAM_CONTENT_TYPE


def _headers_to_pairs(headers: Any) -> list[tuple[str, str]]:
    """Return header pairs from mitmproxy, tests, or captured JSON."""

    if not headers:
        return []

    if isinstance(headers, dict):
        return [(str(k), str(v)) for k, v in headers.items()]

    if isinstance(headers, list):
        pairs: list[tuple[str, str]] = []
        for item in headers:
            if isinstance(item, (list, tuple)) and len(item) == 2:
                pairs.append((str(item[0]), str(item[1])))
        return pairs

    pairs = []
    try:
        keys = list(headers.keys())
    except Exception:
        try:
            return [(str(k), str(v)) for k, v in headers.items()]
        except Exception:
            return []

    for key in keys:
        try:
            values = headers.get_all(key)
        except Exception:
            try:
                values = [headers[key]]
            except Exception:
                values = []
        for value in values:
            pairs.append((str(key), str(value)))
    return pairs


def _header_value(headers: Any, name: str) -> str | None:
    lower_name = name.lower()
    for key, value in _headers_to_pairs(headers):
        if key.lower() == lower_name:
            return value
    return None


def _redact_header_value(name: str, value: str) -> str:
    lower_name = name.lower()
    if lower_name in SECRET_HEADER_NAMES:
        return "[redacted]"
    if lower_name == "cookie" or lower_name == "set-cookie":
        return "[redacted]"
    if "bearer " in value.lower():
        return re.sub(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]", value)
    if "signature=" in value.lower() or "credential=" in value.lower():
        return "[redacted]"
    return value


def redact_headers(headers: Any) -> list[list[str]]:
    return [[name, _redact_header_value(name, value)] for name, value in _headers_to_pairs(headers)]


def _redact_path(path: str) -> str:
    split = urllib.parse.urlsplit(path)
    if not split.query:
        return path
    pairs = urllib.parse.parse_qsl(split.query, keep_blank_values=True)
    redacted = []
    for key, value in pairs:
        if key.lower() in PRESIGNED_QUERY_KEYS:
            redacted.append((key, "[redacted]"))
        else:
            redacted.append((key, value))
    return urllib.parse.urlunsplit(
        ("", "", split.path, urllib.parse.urlencode(redacted), split.fragment)
    )


def is_bedrock_runtime_host(host: str | None) -> bool:
    if not host:
        return False
    host = host.split(":", 1)[0].strip(".").lower()
    patterns = (
        "bedrock-runtime.*.amazonaws.com",
        "bedrock-runtime-fips.*.amazonaws.com",
        "*.bedrock-runtime.*.amazonaws.com",
        "*.bedrock-runtime-fips.*.amazonaws.com",
        "bedrock-runtime.*.amazonaws.com.cn",
        "bedrock-runtime-fips.*.amazonaws.com.cn",
        "*.bedrock-runtime.*.amazonaws.com.cn",
        "*.bedrock-runtime-fips.*.amazonaws.com.cn",
    )
    return any(fnmatch.fnmatchcase(host, pattern) for pattern in patterns)


def detect_bedrock_request(host: str | None, path: str, headers: Any = None) -> dict[str, str] | None:
    """Detect Bedrock Runtime model operations from host + REST path."""

    if not is_bedrock_runtime_host(host):
        return None

    url_path = urllib.parse.urlsplit(path).path
    match = re.match(
        r"^/model/(?P<model_id>.+)/(?P<operation>invoke|invoke-with-response-stream|converse|converse-stream)$",
        url_path,
    )
    if not match:
        return None

    operation = match.group("operation")
    if operation not in BEDROCK_OPERATIONS:
        return None

    return {
        "provider": "bedrock",
        "model_id": urllib.parse.unquote(match.group("model_id")),
        "operation": operation,
        "streaming": "true" if operation.endswith("stream") else "false",
    }


def _decode_utf8(data: bytes) -> str | None:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _event_base(flow: Any, direction: str, info: dict[str, str]) -> dict[str, Any]:
    request = flow.request
    return {
        "version": 1,
        "ts": time.time(),
        "direction": direction,
        "flow_id": str(getattr(flow, "id", "")),
        "provider": "bedrock",
        "operation": info["operation"],
        "model_id": info["model_id"],
        "host": str(getattr(request, "pretty_host", None) or getattr(request, "host", "")),
        "method": str(getattr(request, "method", "")),
        "path": _redact_path(str(getattr(request, "path", ""))),
    }


def _request_body_bytes(flow: Any) -> bytes:
    body = getattr(flow.request, "raw_content", None)
    if body is None:
        body = getattr(flow.request, "content", b"") or b""
    return body


def _response_body_bytes(flow: Any) -> bytes:
    response = getattr(flow, "response", None)
    if response is None:
        return b""
    body = getattr(response, "raw_content", None)
    if body is None:
        body = getattr(response, "content", b"") or b""
    return body


def _write_event(event: dict[str, Any]) -> None:
    if not os.path.exists(SPY_ENABLED):
        return
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
    try:
        fd = os.open(SPY_EVENTS, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o666)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)
    except OSError:
        # The spy tap must never interfere with user traffic.
        return


def capture_request(flow: Any) -> None:
    """mitmproxy hook helper. Capture a validated Bedrock request if enabled."""

    try:
        if not os.path.exists(SPY_ENABLED):
            return
        request = flow.request
        info = detect_bedrock_request(
            getattr(request, "pretty_host", None) or getattr(request, "host", None),
            str(getattr(request, "path", "")),
            getattr(request, "headers", None),
        )
        if not info:
            return
        if not _is_json_content_type(_header_value(getattr(request, "headers", None), "content-type")):
            return

        metadata = getattr(flow, "metadata", None)
        if isinstance(metadata, dict):
            metadata["agent_spy"] = info

        body = _request_body_bytes(flow)
        event = _event_base(flow, "request", info)
        event["headers"] = redact_headers(getattr(request, "headers", None))
        text = _decode_utf8(body)
        if text is None:
            event["body_b64"] = base64.b64encode(body).decode("ascii")
            event["body_sha256"] = _sha256_bytes(body)
        else:
            event["body_text"] = text
        _write_event(event)
    except Exception as exc:  # pragma: no cover - defensive for live traffic.
        _write_event({"version": 1, "ts": time.time(), "direction": "error", "error": str(exc)})


def capture_response(flow: Any) -> None:
    """mitmproxy hook helper. Capture a Bedrock response if its request matched."""

    try:
        if not os.path.exists(SPY_ENABLED):
            return
        metadata = getattr(flow, "metadata", None)
        info = metadata.get("agent_spy") if isinstance(metadata, dict) else None
        if not info:
            request = flow.request
            info = detect_bedrock_request(
                getattr(request, "pretty_host", None) or getattr(request, "host", None),
                str(getattr(request, "path", "")),
                getattr(request, "headers", None),
            )
        if not info or getattr(flow, "response", None) is None:
            return

        response = flow.response
        event = _event_base(flow, "response", info)
        event["status_code"] = int(getattr(response, "status_code", 0) or 0)
        event["reason"] = str(getattr(response, "reason", "") or "")
        event["headers"] = redact_headers(getattr(response, "headers", None))
        event["request_headers"] = redact_headers(getattr(flow.request, "headers", None))

        body = _response_body_bytes(flow)
        content_type = _header_value(getattr(response, "headers", None), "content-type")
        if _is_eventstream_content_type(content_type):
            event["body_b64"] = base64.b64encode(body).decode("ascii")
            event["body_sha256"] = _sha256_bytes(body)
            event["body_encoding"] = "aws-eventstream"
        else:
            text = _decode_utf8(body)
            if text is None:
                event["body_b64"] = base64.b64encode(body).decode("ascii")
                event["body_sha256"] = _sha256_bytes(body)
            else:
                event["body_text"] = text
        _write_event(event)
    except Exception as exc:  # pragma: no cover - defensive for live traffic.
        _write_event({"version": 1, "ts": time.time(), "direction": "error", "error": str(exc)})


def _looks_base64(value: str) -> bool:
    if len(value) < 64:
        return False
    if len(value) % 4 != 0:
        return False
    return re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", value) is not None


def _binary_summary(value: str, media_type: str | None = None) -> str | None:
    if not _looks_base64(value):
        return None
    try:
        raw = base64.b64decode(value, validate=True)
    except binascii.Error:
        return None
    label = media_type or "base64"
    return f"[{label} base64 {len(raw)} bytes sha256:{_sha256_bytes(raw)[:16]}]"


def summarize_binary_fields(value: Any, media_type: str | None = None) -> Any:
    if isinstance(value, list):
        return [summarize_binary_fields(v, media_type) for v in value]
    if isinstance(value, dict):
        local_media_type = (
            value.get("media_type")
            or value.get("mediaType")
            or value.get("format")
            or media_type
        )
        summarized: dict[str, Any] = {}
        for key, item in value.items():
            lower_key = str(key).lower()
            if isinstance(item, str) and lower_key in {"bytes", "data"}:
                summary = _binary_summary(item, str(local_media_type) if local_media_type else None)
                summarized[key] = summary if summary is not None else item
            else:
                summarized[key] = summarize_binary_fields(
                    item,
                    str(local_media_type) if local_media_type else media_type,
                )
        return summarized
    if isinstance(value, str):
        summary = _binary_summary(value, media_type)
        return summary if summary is not None else value
    return value


class EventStreamDecodeError(ValueError):
    pass


def decode_event_stream(data: bytes) -> list[dict[str, Any]]:
    """Decode AWS event-stream messages.

    Frame layout: total length, headers length, prelude CRC, headers,
    payload, message CRC. Integers are big-endian.
    """

    messages = []
    pos = 0
    while pos < len(data):
        if len(data) - pos < 16:
            raise EventStreamDecodeError("truncated prelude")
        total_len, headers_len = struct.unpack(">II", data[pos : pos + 8])
        if total_len < 16:
            raise EventStreamDecodeError(f"invalid total length {total_len}")
        end = pos + total_len
        if end > len(data):
            raise EventStreamDecodeError("truncated message")

        expected_prelude_crc = struct.unpack(">I", data[pos + 8 : pos + 12])[0]
        actual_prelude_crc = binascii.crc32(data[pos : pos + 8]) & 0xFFFFFFFF
        if expected_prelude_crc != actual_prelude_crc:
            raise EventStreamDecodeError("prelude CRC mismatch")

        expected_message_crc = struct.unpack(">I", data[end - 4 : end])[0]
        actual_message_crc = binascii.crc32(data[pos : end - 4]) & 0xFFFFFFFF
        if expected_message_crc != actual_message_crc:
            raise EventStreamDecodeError("message CRC mismatch")

        headers_start = pos + 12
        headers_end = headers_start + headers_len
        if headers_end > end - 4:
            raise EventStreamDecodeError("headers exceed message")
        headers = _decode_event_headers(data[headers_start:headers_end])
        payload = data[headers_end : end - 4]
        messages.append({"headers": headers, "payload": payload})
        pos = end
    return messages


def _decode_event_headers(data: bytes) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    pos = 0
    while pos < len(data):
        name_len = data[pos]
        pos += 1
        if pos + name_len + 1 > len(data):
            raise EventStreamDecodeError("truncated header")
        name = data[pos : pos + name_len].decode("utf-8")
        pos += name_len
        value_type = data[pos]
        pos += 1

        if value_type == 0:
            value: Any = True
        elif value_type == 1:
            value = False
        elif value_type == 2:
            value = struct.unpack(">b", data[pos : pos + 1])[0]
            pos += 1
        elif value_type == 3:
            value = struct.unpack(">h", data[pos : pos + 2])[0]
            pos += 2
        elif value_type == 4:
            value = struct.unpack(">i", data[pos : pos + 4])[0]
            pos += 4
        elif value_type == 5:
            value = struct.unpack(">q", data[pos : pos + 8])[0]
            pos += 8
        elif value_type in {6, 7}:
            length = struct.unpack(">H", data[pos : pos + 2])[0]
            pos += 2
            raw = data[pos : pos + length]
            pos += length
            value = raw if value_type == 6 else raw.decode("utf-8")
        elif value_type == 8:
            millis = struct.unpack(">q", data[pos : pos + 8])[0]
            pos += 8
            value = _dt.datetime.fromtimestamp(millis / 1000, tz=_dt.timezone.utc).isoformat()
        elif value_type == 9:
            raw = data[pos : pos + 16]
            pos += 16
            value = raw.hex()
        else:
            raise EventStreamDecodeError(f"unknown header type {value_type}")
        headers[name] = value
    return headers


def _parse_json_text(text: str | None) -> Any | None:
    if text is None:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _parse_payload_json(payload: bytes) -> Any | None:
    text = _decode_utf8(payload)
    if text is None:
        return None
    return _parse_json_text(text)


def _indent_lines(text: str, prefix: str) -> list[str]:
    parts = str(text).splitlines()
    if not parts:
        return [prefix]
    return [prefix + part for part in parts]


def _append_block_text(lines: list[str], label: str, text: Any, indent: str = "  ") -> None:
    lines.append(f"{indent}{label}:")
    lines.extend(_indent_lines(str(text), f"{indent}  "))


def _compact_json(value: Any) -> str:
    return json.dumps(summarize_binary_fields(value), ensure_ascii=False, sort_keys=True)


def _append_json(lines: list[str], value: Any, indent: str = "  ") -> None:
    rendered = json.dumps(
        summarize_binary_fields(value),
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    )
    lines.extend(_indent_lines(rendered, indent))


def _format_ts(ts: Any) -> str:
    try:
        return _dt.datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "unknown-time"


def _format_headers(lines: list[str], headers: Any, indent: str = "  ") -> None:
    selected = []
    for name, value in _headers_to_pairs(headers):
        lower = name.lower()
        if lower in INTERESTING_HEADER_NAMES or lower.startswith("x-amzn-"):
            selected.append((name, value))
    if not selected:
        return
    lines.append(f"{indent}headers:")
    for name, value in selected:
        lines.append(f"{indent}  {name}: {value}")


def _cache_marker(block: Any) -> bool:
    if not isinstance(block, dict):
        return False
    if "cachePoint" in block:
        return True
    if "cache_control" in block:
        return True
    return False


def _as_blocks(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


class SpyFormatter:
    def __init__(self, raw: bool = False, dedupe: bool = True) -> None:
        self.raw = raw
        self.dedupe = dedupe
        self.seen_cache_prefixes: dict[str, int] = {}

    def format_event(self, event: dict[str, Any]) -> str:
        direction = event.get("direction")
        if direction == "request":
            lines = self._format_request(event)
        elif direction == "response":
            lines = self._format_response(event)
        else:
            lines = [f"[{_format_ts(event.get('ts'))}] ! spy error: {event.get('error', event)}"]
        return "\n".join(lines) + "\n"

    def _headline(self, event: dict[str, Any], arrow: str) -> str:
        op = event.get("operation", "unknown")
        model = event.get("model_id", "unknown-model")
        return f"[{_format_ts(event.get('ts'))}] {arrow} Bedrock {op} model={model}"

    def _format_request(self, event: dict[str, Any]) -> list[str]:
        lines = [self._headline(event, "->")]
        lines.append(f"  {event.get('method', 'POST')} {event.get('host')}{event.get('path')}")
        _format_headers(lines, event.get("headers"))

        body = _parse_json_text(event.get("body_text"))
        if body is None:
            lines.append(self._body_fallback(event, "request"))
        elif event.get("operation") in {"converse", "converse-stream"}:
            self._format_converse_request(lines, event, body)
        elif self._looks_like_claude(body, event):
            self._format_claude_request(lines, event, body)
        else:
            self._format_generic_request(lines, body)

        if self.raw:
            self._append_raw_body(lines, event, body, "raw request body")
        return lines

    def _format_response(self, event: dict[str, Any]) -> list[str]:
        status = event.get("status_code", 0)
        reason = f" {event.get('reason')}" if event.get("reason") else ""
        lines = [f"{self._headline(event, '<-')} status={status}{reason}"]
        _format_headers(lines, event.get("headers"))

        if event.get("body_encoding") == "aws-eventstream":
            self._format_eventstream_response(lines, event)
        else:
            body = _parse_json_text(event.get("body_text"))
            if body is None:
                lines.append(self._body_fallback(event, "response"))
            elif event.get("operation") in {"converse", "converse-stream"}:
                self._format_converse_response(lines, body)
            elif self._looks_like_claude(body, event):
                self._format_claude_response(lines, body)
            else:
                self._format_generic_response(lines, body)
            if self.raw:
                self._append_raw_body(lines, event, body, "raw response body")
        return lines

    def _body_fallback(self, event: dict[str, Any], label: str) -> str:
        if event.get("body_b64"):
            try:
                raw = base64.b64decode(event["body_b64"])
                return f"  {label}: [{len(raw)} bytes sha256:{_sha256_bytes(raw)[:16]}]"
            except binascii.Error:
                return f"  {label}: [base64 decode failed]"
        text = event.get("body_text", "")
        return f"  {label}: {text!r}"

    def _append_raw_body(
        self,
        lines: list[str],
        event: dict[str, Any],
        parsed_body: Any | None,
        label: str,
    ) -> None:
        lines.append(f"  {label}:")
        if parsed_body is not None:
            _append_json(lines, parsed_body, "    ")
        elif event.get("body_text") is not None:
            lines.extend(_indent_lines(event["body_text"], "    "))
        elif event.get("body_b64"):
            raw = base64.b64decode(event["body_b64"])
            lines.append(f"    [{len(raw)} bytes sha256:{_sha256_bytes(raw)[:16]}]")

    def _looks_like_claude(self, body: Any, event: dict[str, Any]) -> bool:
        if not isinstance(body, dict):
            return False
        model_id = str(event.get("model_id", ""))
        return (
            "anthropic_version" in body
            or "anthropic." in model_id
            or any(isinstance(block, dict) and block.get("type") == "tool_use" for block in _message_blocks(body))
        )

    def _cache_filtered_units(
        self,
        event: dict[str, Any],
        units: list[dict[str, Any]],
    ) -> tuple[list[str], list[dict[str, Any]]]:
        if not self.dedupe:
            return [], units
        marker_index = -1
        for idx, unit in enumerate(units):
            if _cache_marker(unit.get("block")):
                marker_index = idx
        if marker_index < 0:
            return [], units

        prefix = units[: marker_index + 1]
        fp = _sha256_json(prefix)[:16]
        key = f"{event.get('provider')}:{event.get('operation')}:{event.get('model_id')}:{fp}"
        seen_count = self.seen_cache_prefixes.get(key, 0)
        self.seen_cache_prefixes[key] = seen_count + 1
        if seen_count:
            note = [f"  [cached prefix sha256:{fp} omitted; seen {seen_count + 1} times]"]
            suffix = units[marker_index + 1 :]
            if not suffix:
                note.append("  [no prompt suffix after cached prefix]")
            return note, suffix
        return [f"  [cache prefix sha256:{fp} recorded; future repeats will be elided]"], units

    def _format_prompt_units(self, lines: list[str], units: list[dict[str, Any]]) -> None:
        current = None
        for unit in units:
            role = unit.get("role", "prompt")
            if role != current:
                lines.append(f"  {role}:")
                current = role
            self._format_content_block(lines, unit.get("block"), "    ")

    def _format_converse_request(self, lines: list[str], event: dict[str, Any], body: dict[str, Any]) -> None:
        for key in ("inferenceConfig", "additionalModelRequestFields", "guardrailConfig"):
            if key in body:
                lines.append(f"  {key}: {_compact_json(body[key])}")

        units = _converse_prompt_units(body)
        notes, visible_units = self._cache_filtered_units(event, units)
        lines.extend(notes)
        if visible_units:
            self._format_prompt_units(lines, visible_units)

        tool_config = body.get("toolConfig")
        if isinstance(tool_config, dict):
            self._format_converse_tools(lines, tool_config)

    def _format_claude_request(self, lines: list[str], event: dict[str, Any], body: dict[str, Any]) -> None:
        for key in ("anthropic_version", "max_tokens", "temperature", "top_p", "top_k", "thinking"):
            if key in body:
                lines.append(f"  {key}: {_compact_json(body[key])}")

        units = _claude_prompt_units(body)
        notes, visible_units = self._cache_filtered_units(event, units)
        lines.extend(notes)
        if visible_units:
            self._format_prompt_units(lines, visible_units)

        tools = body.get("tools")
        if isinstance(tools, list):
            self._format_claude_tools(lines, tools)

    def _format_generic_request(self, lines: list[str], body: Any) -> None:
        lines.append("  request JSON:")
        _append_json(lines, body, "    ")

    def _format_converse_tools(self, lines: list[str], tool_config: dict[str, Any]) -> None:
        tools = tool_config.get("tools")
        if isinstance(tools, list) and tools:
            lines.append("  tools:")
            for tool in tools:
                spec = tool.get("toolSpec") if isinstance(tool, dict) else None
                if isinstance(spec, dict):
                    name = spec.get("name", "<unnamed>")
                    lines.append(f"    - {name}")
                    if spec.get("description"):
                        _append_block_text(lines, "description", spec["description"], "      ")
                    if spec.get("inputSchema"):
                        lines.append("      inputSchema:")
                        _append_json(lines, spec["inputSchema"], "        ")
                else:
                    lines.append(f"    - {_compact_json(tool)}")
        if tool_config.get("toolChoice") is not None:
            lines.append(f"  toolChoice: {_compact_json(tool_config['toolChoice'])}")

    def _format_claude_tools(self, lines: list[str], tools: list[Any]) -> None:
        if not tools:
            return
        lines.append("  tools:")
        for tool in tools:
            if isinstance(tool, dict):
                lines.append(f"    - {tool.get('name', '<unnamed>')}")
                if tool.get("description"):
                    _append_block_text(lines, "description", tool["description"], "      ")
                schema = tool.get("input_schema") or tool.get("inputSchema")
                if schema:
                    lines.append("      input_schema:")
                    _append_json(lines, schema, "        ")
            else:
                lines.append(f"    - {tool!r}")

    def _format_content_block(self, lines: list[str], block: Any, indent: str) -> None:
        if isinstance(block, str):
            _append_block_text(lines, "text", block, indent)
            return
        if not isinstance(block, dict):
            lines.append(f"{indent}{block!r}")
            return

        if "text" in block and isinstance(block["text"], str):
            _append_block_text(lines, "text", block["text"], indent)
        if block.get("type") == "text" and "text" in block:
            pass
        elif block.get("type") == "thinking" and "thinking" in block:
            _append_block_text(lines, "thinking", block["thinking"], indent)
        elif block.get("type") == "redacted_thinking":
            lines.append(f"{indent}redacted_thinking: {_compact_json(block)}")
        elif block.get("type") == "tool_use":
            lines.append(f"{indent}tool_use {block.get('name', '<unnamed>')} id={block.get('id', '<missing>')}")
            if "input" in block:
                _append_json(lines, block["input"], indent + "  ")
        elif block.get("type") == "tool_result":
            lines.append(f"{indent}tool_result for={block.get('tool_use_id', '<missing>')}")
            if "content" in block:
                self._format_nested_content(lines, block["content"], indent + "  ")
        elif "toolUse" in block and isinstance(block["toolUse"], dict):
            tool = block["toolUse"]
            lines.append(f"{indent}toolUse {tool.get('name', '<unnamed>')} id={tool.get('toolUseId', '<missing>')}")
            if "input" in tool:
                _append_json(lines, tool["input"], indent + "  ")
        elif "toolResult" in block and isinstance(block["toolResult"], dict):
            result = block["toolResult"]
            status = f" status={result.get('status')}" if result.get("status") else ""
            lines.append(f"{indent}toolResult for={result.get('toolUseId', '<missing>')}{status}")
            if "content" in result:
                self._format_nested_content(lines, result["content"], indent + "  ")
        elif "image" in block or "document" in block or "video" in block:
            lines.append(f"{indent}media: {_compact_json(block)}")
        elif "cachePoint" in block:
            lines.append(f"{indent}cachePoint: {_compact_json(block['cachePoint'])}")
        elif "cache_control" in block and set(block.keys()) == {"cache_control"}:
            lines.append(f"{indent}cache_control: {_compact_json(block['cache_control'])}")
        elif not ("text" in block and isinstance(block["text"], str)):
            lines.append(f"{indent}{_compact_json(block)}")

        if "cache_control" in block and set(block.keys()) != {"cache_control"}:
            lines.append(f"{indent}cache_control: {_compact_json(block['cache_control'])}")
        if "cachePoint" in block and len(block) > 1:
            lines.append(f"{indent}cachePoint: {_compact_json(block['cachePoint'])}")

    def _format_nested_content(self, lines: list[str], content: Any, indent: str) -> None:
        for block in _as_blocks(content):
            self._format_content_block(lines, block, indent)

    def _format_converse_response(self, lines: list[str], body: dict[str, Any]) -> None:
        output = body.get("output")
        if isinstance(output, dict) and isinstance(output.get("message"), dict):
            message = output["message"]
            role = message.get("role", "assistant")
            lines.append(f"  {role}:")
            for block in _as_blocks(message.get("content")):
                self._format_content_block(lines, block, "    ")
        elif output is not None:
            lines.append("  output:")
            _append_json(lines, output, "    ")

        self._format_usage(lines, body.get("usage"))
        if body.get("stopReason"):
            lines.append(f"  stopReason: {body['stopReason']}")
        if body.get("metrics"):
            lines.append(f"  metrics: {_compact_json(body['metrics'])}")

    def _format_claude_response(self, lines: list[str], body: dict[str, Any]) -> None:
        if body.get("role") or body.get("content"):
            lines.append(f"  {body.get('role', 'assistant')}:")
            for block in _as_blocks(body.get("content")):
                self._format_content_block(lines, block, "    ")
        self._format_usage(lines, body.get("usage"))
        if body.get("stop_reason"):
            lines.append(f"  stop_reason: {body['stop_reason']}")
        if body.get("model"):
            lines.append(f"  response_model: {body['model']}")

    def _format_generic_response(self, lines: list[str], body: Any) -> None:
        lines.append("  response JSON:")
        _append_json(lines, body, "    ")

    def _format_usage(self, lines: list[str], usage: Any) -> None:
        if not isinstance(usage, dict):
            return
        pieces = []
        aliases = {
            "inputTokens": "input",
            "outputTokens": "output",
            "totalTokens": "total",
            "cacheReadInputTokens": "cache_read",
            "cacheWriteInputTokens": "cache_write",
            "cacheReadInputTokenCount": "cache_read",
            "cacheWriteInputTokenCount": "cache_write",
            "cacheReadInputTokensCount": "cache_read",
            "cacheWriteInputTokensCount": "cache_write",
            "input_tokens": "input",
            "output_tokens": "output",
            "cache_read_input_tokens": "cache_read",
            "cache_creation_input_tokens": "cache_write",
        }
        for key, label in aliases.items():
            if key in usage:
                pieces.append(f"{label}={usage[key]}")
        for key, value in usage.items():
            if key not in aliases:
                pieces.append(f"{key}={value}")
        if pieces:
            lines.append(f"  usage: {', '.join(pieces)}")

    def _format_eventstream_response(self, lines: list[str], event: dict[str, Any]) -> None:
        try:
            raw = base64.b64decode(event.get("body_b64", ""))
            messages = decode_event_stream(raw)
        except (binascii.Error, EventStreamDecodeError) as exc:
            raw = base64.b64decode(event.get("body_b64", "") or b"")
            lines.append(
                f"  event stream decode failed: {exc}; {len(raw)} bytes sha256:{_sha256_bytes(raw)[:16]}"
            )
            return

        summary = _StreamSummary()
        unknown = []
        for message in messages:
            headers = message["headers"]
            payload = message["payload"]
            payload_obj = _parse_payload_json(payload)
            if isinstance(payload_obj, dict) and isinstance(payload_obj.get("chunk"), dict):
                chunk_bytes = payload_obj["chunk"].get("bytes")
                if isinstance(chunk_bytes, str):
                    try:
                        payload = base64.b64decode(chunk_bytes)
                        payload_obj = _parse_payload_json(payload)
                    except binascii.Error:
                        pass
            if not summary.consume(headers, payload_obj, payload):
                event_type = headers.get(":event-type") or headers.get(":message-type") or "event"
                if payload_obj is None:
                    unknown.append(
                        f"{event_type}: [{len(payload)} bytes sha256:{_sha256_bytes(payload)[:16]}]"
                    )
                else:
                    unknown.append(f"{event_type}: {_compact_json(payload_obj)}")

        summary.render(lines)
        for item in unknown:
            lines.append(f"  stream {item}")

        if self.raw:
            lines.append("  raw event stream:")
            for message in messages:
                headers = message["headers"]
                payload = message["payload"]
                payload_obj = _parse_payload_json(payload)
                lines.append(f"    event headers: {_compact_json(headers)}")
                if payload_obj is None:
                    lines.append(f"    payload: [{len(payload)} bytes sha256:{_sha256_bytes(payload)[:16]}]")
                else:
                    _append_json(lines, payload_obj, "    ")


class _StreamSummary:
    def __init__(self) -> None:
        self.role: str | None = None
        self.text: list[str] = []
        self.thinking: list[str] = []
        self.tool_starts: list[dict[str, Any]] = []
        self.tool_input_chunks: list[str] = []
        self.usage: dict[str, Any] | None = None
        self.stop_reason: str | None = None

    def consume(self, headers: dict[str, Any], obj: Any, payload: bytes) -> bool:
        if not isinstance(obj, dict):
            return False

        if "messageStart" in obj:
            start = obj["messageStart"]
            if isinstance(start, dict):
                self.role = start.get("role") or self.role
            return True

        if "contentBlockStart" in obj:
            start = obj["contentBlockStart"].get("start") if isinstance(obj["contentBlockStart"], dict) else None
            if isinstance(start, dict) and isinstance(start.get("toolUse"), dict):
                self.tool_starts.append(start["toolUse"])
            return True

        if "contentBlockDelta" in obj:
            delta = obj["contentBlockDelta"].get("delta") if isinstance(obj["contentBlockDelta"], dict) else None
            if isinstance(delta, dict):
                if isinstance(delta.get("text"), str):
                    self.text.append(delta["text"])
                    return True
                if isinstance(delta.get("reasoningContent"), dict):
                    reasoning = delta["reasoningContent"]
                    if isinstance(reasoning.get("text"), str):
                        self.thinking.append(reasoning["text"])
                        return True
                if isinstance(delta.get("toolUse"), dict):
                    tool_use = delta["toolUse"]
                    if isinstance(tool_use.get("input"), str):
                        self.tool_input_chunks.append(tool_use["input"])
                    return True
            return True

        if "messageStop" in obj:
            stop = obj["messageStop"]
            if isinstance(stop, dict):
                self.stop_reason = stop.get("stopReason") or self.stop_reason
            return True

        if "metadata" in obj:
            meta = obj["metadata"]
            if isinstance(meta, dict) and isinstance(meta.get("usage"), dict):
                self.usage = meta["usage"]
            return True

        event_type = obj.get("type")
        if event_type == "message_start":
            message = obj.get("message")
            if isinstance(message, dict):
                self.role = message.get("role") or self.role
                if isinstance(message.get("usage"), dict):
                    self.usage = message["usage"]
            return True
        if event_type == "content_block_start":
            block = obj.get("content_block")
            if isinstance(block, dict) and block.get("type") == "tool_use":
                self.tool_starts.append(block)
            return True
        if event_type == "content_block_delta":
            delta = obj.get("delta")
            if isinstance(delta, dict):
                if isinstance(delta.get("text"), str):
                    self.text.append(delta["text"])
                    return True
                if isinstance(delta.get("thinking"), str):
                    self.thinking.append(delta["thinking"])
                    return True
                if isinstance(delta.get("partial_json"), str):
                    self.tool_input_chunks.append(delta["partial_json"])
                    return True
            return True
        if event_type == "message_delta":
            delta = obj.get("delta")
            if isinstance(delta, dict):
                self.stop_reason = delta.get("stop_reason") or self.stop_reason
            usage = obj.get("usage")
            if isinstance(usage, dict):
                self.usage = usage
            return True
        if event_type in {"content_block_stop", "message_stop", "ping"}:
            return True

        return False

    def render(self, lines: list[str]) -> None:
        if self.thinking:
            _append_block_text(lines, "thinking", "".join(self.thinking), "  ")
        if self.text:
            _append_block_text(lines, self.role or "assistant", "".join(self.text), "  ")
        if self.tool_starts:
            lines.append("  tool calls:")
            for tool in self.tool_starts:
                name = tool.get("name", "<unnamed>")
                ident = tool.get("toolUseId") or tool.get("id") or "<missing>"
                lines.append(f"    - {name} id={ident}")
        if self.tool_input_chunks:
            _append_block_text(lines, "tool input delta", "".join(self.tool_input_chunks), "  ")
        if self.usage:
            formatter = SpyFormatter()
            formatter._format_usage(lines, self.usage)
        if self.stop_reason:
            lines.append(f"  stop: {self.stop_reason}")


def _converse_prompt_units(body: dict[str, Any]) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    for block in _as_blocks(body.get("system")):
        units.append({"role": "system", "block": block})
    for message in _as_blocks(body.get("messages")):
        if not isinstance(message, dict):
            units.append({"role": "message", "block": message})
            continue
        role = message.get("role", "message")
        for block in _as_blocks(message.get("content")):
            units.append({"role": str(role), "block": block})
    return units


def _claude_prompt_units(body: dict[str, Any]) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    system = body.get("system")
    if isinstance(system, list):
        for block in system:
            units.append({"role": "system", "block": block})
    elif system is not None:
        units.append({"role": "system", "block": system})
    for message in _as_blocks(body.get("messages")):
        if not isinstance(message, dict):
            units.append({"role": "message", "block": message})
            continue
        role = message.get("role", "message")
        for block in _as_blocks(message.get("content")):
            units.append({"role": str(role), "block": block})
    return units


def _message_blocks(body: dict[str, Any]) -> Iterable[Any]:
    for message in _as_blocks(body.get("messages")):
        if isinstance(message, dict):
            yield from _as_blocks(message.get("content"))


def _tail_events(path: str, formatter: SpyFormatter) -> None:
    while not os.path.exists(path):
        time.sleep(0.1)

    with open(path, "r", encoding="utf-8") as f:
        while True:
            line = f.readline()
            if not line:
                time.sleep(0.2)
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"[spy] skipped malformed event: {exc}", flush=True)
                continue
            print(formatter.format_event(event), end="\n", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Tail formatted Bedrock traffic captured by mitmproxy.")
    sub = parser.add_subparsers(dest="cmd")

    tail = sub.add_parser("tail", help="tail the live spy event stream")
    tail.add_argument("--events", default=SPY_EVENTS, help="path to the NDJSON event stream")
    tail.add_argument("--raw", action="store_true", help="include sanitized raw JSON bodies")
    tail.add_argument("--no-dedupe", action="store_true", help="do not elide repeated cache-marked prefixes")

    args = parser.parse_args(argv)
    if args.cmd == "tail":
        try:
            _tail_events(args.events, SpyFormatter(raw=args.raw, dedupe=not args.no_dedupe))
        except KeyboardInterrupt:
            return 130
        return 0

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
