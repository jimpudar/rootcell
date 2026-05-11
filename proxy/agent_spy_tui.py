#!/usr/bin/env python3
"""Textual navigator for the agent spy event stream.

The capture path intentionally stays in agent_spy.py and remains usable with a
plain stdlib Python. Textual is imported only when the TUI is launched.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import agent_spy


@dataclass
class DetailSection:
    title: str
    body: str
    collapsed: bool = False


@dataclass
class CallPair:
    index: int
    flow_id: str
    request: dict[str, Any] | None = None
    response: dict[str, Any] | None = None
    errors: list[str] = field(default_factory=list)


@dataclass
class StreamView:
    role: str | None = None
    text: list[str] = field(default_factory=list)
    thinking: list[str] = field(default_factory=list)
    tool_starts: list[dict[str, Any]] = field(default_factory=list)
    tool_input_chunks: list[str] = field(default_factory=list)
    usage: dict[str, Any] | None = None
    metrics: dict[str, Any] | None = None
    stop_reason: str | None = None
    unknown: list[str] = field(default_factory=list)
    raw: list[str] = field(default_factory=list)


class EventPairStore:
    """Pair request/response events by flow_id while preserving arrival order."""

    def __init__(self, raw: bool = False, dedupe: bool = True) -> None:
        self.raw = raw
        self.calls: list[CallPair] = []
        self._waiting: dict[str, list[CallPair]] = {}
        self._formatter = agent_spy.SpyFormatter(raw=raw, dedupe=dedupe)
        self._next_index = 0

    def add_event(self, event: dict[str, Any]) -> CallPair:
        direction = event.get("direction")
        if direction not in {"request", "response"}:
            call = self._new_call(str(event.get("flow_id") or f"error-{self._next_index}"))
            call.errors.append(str(event.get("error", event)))
            return call

        flow_id = str(event.get("flow_id") or f"event-{self._next_index}")
        missing = "request" if direction == "request" else "response"
        call = self._find_waiting(flow_id, missing) or self._new_call(flow_id)

        stored = dict(event)
        stored["_agent_spy_tui_formatted"] = self._formatter.format_event(event).rstrip()
        stored["_agent_spy_tui_raw"] = self.raw
        if direction == "request":
            call.request = stored
        else:
            call.response = stored

        if call.request is not None and call.response is not None:
            self._remove_waiting(flow_id, call)
        else:
            self._remember_waiting(flow_id, call)
        return call

    def _new_call(self, flow_id: str) -> CallPair:
        call = CallPair(index=self._next_index, flow_id=flow_id)
        self._next_index += 1
        self.calls.append(call)
        return call

    def _find_waiting(self, flow_id: str, missing: str) -> CallPair | None:
        for call in self._waiting.get(flow_id, []):
            if missing == "request" and call.request is None:
                return call
            if missing == "response" and call.response is None:
                return call
        return None

    def _remember_waiting(self, flow_id: str, call: CallPair) -> None:
        waiting = self._waiting.setdefault(flow_id, [])
        if call not in waiting:
            waiting.append(call)

    def _remove_waiting(self, flow_id: str, call: CallPair) -> None:
        waiting = self._waiting.get(flow_id)
        if not waiting:
            return
        self._waiting[flow_id] = [item for item in waiting if item is not call]
        if not self._waiting[flow_id]:
            del self._waiting[flow_id]


def parse_event_line(line: str) -> dict[str, Any]:
    try:
        event = json.loads(line)
    except json.JSONDecodeError as exc:
        return {
            "version": 1,
            "ts": time.time(),
            "direction": "error",
            "error": f"skipped malformed event: {exc}",
        }
    if not isinstance(event, dict):
        return {
            "version": 1,
            "ts": time.time(),
            "direction": "error",
            "error": f"skipped non-object event: {event!r}",
        }
    return event


class SpyEventReader:
    def __init__(self, path: str) -> None:
        self.path = path
        self._file: Any | None = None

    def read_available(self) -> list[dict[str, Any]]:
        if self._file is None:
            if not os.path.exists(self.path):
                return []
            self._file = open(self.path, "r", encoding="utf-8")
        else:
            try:
                if self._file.tell() > os.path.getsize(self.path):
                    self._file.seek(0)
            except OSError:
                return []

        events = []
        while True:
            line = self._file.readline()
            if not line:
                break
            events.append(parse_event_line(line))
        return events


def call_row(call: CallPair, time_mode: str = "utc") -> tuple[str, str, str, str, str, str]:
    event = call.request or call.response or {}
    response = call.response or {}
    if call.errors:
        status = "error"
    elif call.response is None:
        status = "pending"
    else:
        status_code = response.get("status_code", "")
        reason = response.get("reason", "")
        status = str(status_code) if not reason else f"{status_code} {reason}"

    return (
        format_event_time(event.get("ts"), time_mode),
        status,
        str(event.get("operation", response.get("operation", "unknown"))),
        str(event.get("model_id", response.get("model_id", "unknown-model"))),
        *_input_output_tokens(response),
    )


def format_event_time(ts: Any, mode: str = "utc", local_tz: _dt.tzinfo | None = None) -> str:
    try:
        value = float(ts)
    except Exception:
        return "unknown-time"

    if mode == "local":
        dt = _dt.datetime.fromtimestamp(value, tz=_dt.timezone.utc)
        local = dt.astimezone(local_tz or _local_timezone())
        hour = local.hour % 12 or 12
        zone = local.tzname() or "local"
        return f"{local:%Y-%m-%d} {hour}:{local:%M:%S} {local:%p} {zone}"

    utc = _dt.datetime.fromtimestamp(value, tz=_dt.timezone.utc)
    return f"{utc:%Y-%m-%d %H:%M:%S}"


def time_column_label(mode: str = "utc") -> str:
    if mode == "local":
        zone = _dt.datetime.now(tz=_local_timezone()).tzname() or "local"
        return f"Time ({zone})"
    return "Time (UTC)"


def _local_timezone() -> _dt.tzinfo:
    zone_name = os.environ.get("AGENT_SPY_LOCAL_TZ") or os.environ.get("TZ")
    if zone_name:
        try:
            return ZoneInfo(zone_name)
        except (ValueError, ZoneInfoNotFoundError):
            pass
    return _dt.datetime.now().astimezone().tzinfo or _dt.timezone.utc


def _input_output_tokens(event: dict[str, Any] | None) -> tuple[str, str]:
    usage = _usage_for_event(event)
    if not usage:
        return "", ""
    return (
        _token_value(usage, "inputTokens", "input_tokens"),
        _token_value(usage, "outputTokens", "output_tokens"),
    )


def _token_value(usage: dict[str, Any], *keys: str) -> str:
    for key in keys:
        if key in usage:
            return str(usage[key])
    return ""


def _usage_for_event(event: dict[str, Any] | None) -> dict[str, Any] | None:
    if not event:
        return None

    if event.get("body_encoding") == "aws-eventstream":
        return _eventstream_view(event).usage

    body = agent_spy._parse_json_text(event.get("body_text"))
    if isinstance(body, dict) and isinstance(body.get("usage"), dict):
        return body["usage"]
    return None


def sections_for_call(call: CallPair) -> list[DetailSection]:
    sections: list[DetailSection] = []
    for error in call.errors:
        sections.append(DetailSection("Error", error, collapsed=False))
    if call.request is not None:
        sections.extend(_event_sections("Request", call.request))
    if call.response is not None:
        sections.extend(_event_sections("Response", call.response))
    elif call.request is not None:
        sections.append(DetailSection("Response pending", "No response captured yet.", collapsed=False))
    return sections


def _event_sections(prefix: str, event: dict[str, Any]) -> list[DetailSection]:
    if prefix == "Response" and event.get("body_encoding") == "aws-eventstream":
        return _eventstream_sections(event)

    formatted = event.get("_agent_spy_tui_formatted")
    if not isinstance(formatted, str):
        formatted = agent_spy.SpyFormatter().format_event(event).rstrip()
    return _split_formatted_event(prefix, formatted)


def _eventstream_sections(event: dict[str, Any]) -> list[DetailSection]:
    formatted = event.get("_agent_spy_tui_formatted")
    if not isinstance(formatted, str):
        formatted = agent_spy.SpyFormatter().format_event(event).rstrip()
    lines = formatted.splitlines()
    sections = [DetailSection("Response summary", lines[0] if lines else "", collapsed=False)]

    headers = _headers_section_body(event.get("headers"))
    if headers:
        sections.append(DetailSection("Response headers", headers, collapsed=True))

    view = _eventstream_view(event)
    if view.thinking:
        sections.append(DetailSection("Response thinking", "".join(view.thinking), collapsed=False))
    if view.text:
        sections.append(DetailSection(f"Response {view.role or 'assistant'}", "".join(view.text), collapsed=False))
    if view.tool_starts:
        sections.append(DetailSection("Response tool calls", _tool_calls_body(view.tool_starts), collapsed=False))
    if view.tool_input_chunks:
        sections.append(DetailSection("Response tool input delta", "".join(view.tool_input_chunks), collapsed=False))
    if view.usage:
        sections.append(DetailSection("Response usage", _usage_body(view.usage), collapsed=False))
    if view.metrics:
        sections.append(DetailSection("Response metrics", agent_spy._compact_json(view.metrics), collapsed=False))
    if view.stop_reason:
        sections.append(DetailSection("Response stop", view.stop_reason, collapsed=False))
    if view.unknown:
        sections.append(DetailSection("Response stream events", "\n".join(view.unknown), collapsed=False))
    if event.get("_agent_spy_tui_raw") and view.raw:
        sections.append(DetailSection("Response raw event stream", "\n".join(view.raw), collapsed=True))
    return sections


def _headers_section_body(headers: Any) -> str:
    lines: list[str] = []
    agent_spy._format_headers(lines, headers)
    return "\n".join(lines)


def _tool_calls_body(tools: list[dict[str, Any]]) -> str:
    lines = []
    for tool in tools:
        name = tool.get("name", "<unnamed>")
        ident = tool.get("toolUseId") or tool.get("id") or "<missing>"
        lines.append(f"- {name} id={ident}")
    return "\n".join(lines)


def _usage_body(usage: dict[str, Any]) -> str:
    lines: list[str] = []
    agent_spy.SpyFormatter()._format_usage(lines, usage)
    return "\n".join(line.strip() for line in lines)


def _eventstream_view(event: dict[str, Any]) -> StreamView:
    view = StreamView()
    try:
        raw = agent_spy.base64.b64decode(event.get("body_b64", ""))
        messages = agent_spy.decode_event_stream(raw)
    except (agent_spy.binascii.Error, agent_spy.EventStreamDecodeError) as exc:
        view.unknown.append(f"decode failed: {exc}")
        return view

    for message in messages:
        headers = message["headers"]
        payload = message["payload"]
        payload_obj = _stream_payload_obj(payload)
        event_type = str(headers.get(":event-type") or headers.get(":message-type") or "event")
        if payload_obj is None:
            view.raw.append(
                f"event headers: {agent_spy._compact_json(headers)}\n"
                f"payload: [{len(payload)} bytes sha256:{agent_spy._sha256_bytes(payload)[:16]}]"
            )
            view.unknown.append(f"{event_type}: [{len(payload)} bytes sha256:{agent_spy._sha256_bytes(payload)[:16]}]")
            continue

        view.raw.append(
            f"event headers: {agent_spy._compact_json(headers)}\n"
            f"payload: {agent_spy._compact_json(payload_obj)}"
        )
        if not _consume_stream_payload(view, event_type, payload_obj):
            view.unknown.append(f"{event_type}: {agent_spy._compact_json(payload_obj)}")
    return view


def _stream_payload_obj(payload: bytes) -> Any | None:
    payload_obj = agent_spy._parse_payload_json(payload)
    if isinstance(payload_obj, dict) and isinstance(payload_obj.get("chunk"), dict):
        chunk_bytes = payload_obj["chunk"].get("bytes")
        if isinstance(chunk_bytes, str):
            try:
                payload_obj = agent_spy._parse_payload_json(agent_spy.base64.b64decode(chunk_bytes))
            except agent_spy.binascii.Error:
                pass
    return payload_obj


def _consume_stream_payload(view: StreamView, event_type: str, obj: Any) -> bool:
    if not isinstance(obj, dict):
        return False

    if event_type == "messageStart":
        view.role = obj.get("role") or view.role
        return True
    if event_type == "contentBlockStart":
        start = obj.get("start")
        if isinstance(start, dict) and isinstance(start.get("toolUse"), dict):
            view.tool_starts.append(start["toolUse"])
        return True
    if event_type == "contentBlockDelta":
        return _consume_stream_delta(view, obj.get("delta"))
    if event_type == "contentBlockStop":
        return True
    if event_type == "messageStop":
        view.stop_reason = obj.get("stopReason") or view.stop_reason
        return True
    if event_type == "metadata":
        if isinstance(obj.get("usage"), dict):
            view.usage = obj["usage"]
        if isinstance(obj.get("metrics"), dict):
            view.metrics = obj["metrics"]
        return True

    if "messageStart" in obj:
        start = obj["messageStart"]
        if isinstance(start, dict):
            view.role = start.get("role") or view.role
        return True
    if "contentBlockStart" in obj:
        block_start = obj["contentBlockStart"]
        start = block_start.get("start") if isinstance(block_start, dict) else None
        if isinstance(start, dict) and isinstance(start.get("toolUse"), dict):
            view.tool_starts.append(start["toolUse"])
        return True
    if "contentBlockDelta" in obj:
        block_delta = obj["contentBlockDelta"]
        delta = block_delta.get("delta") if isinstance(block_delta, dict) else None
        return _consume_stream_delta(view, delta)
    if "contentBlockStop" in obj:
        return True
    if "messageStop" in obj:
        stop = obj["messageStop"]
        if isinstance(stop, dict):
            view.stop_reason = stop.get("stopReason") or view.stop_reason
        return True
    if "metadata" in obj:
        meta = obj["metadata"]
        if isinstance(meta, dict) and isinstance(meta.get("usage"), dict):
            view.usage = meta["usage"]
        if isinstance(meta, dict) and isinstance(meta.get("metrics"), dict):
            view.metrics = meta["metrics"]
        return True

    anthropic_type = obj.get("type")
    if anthropic_type == "message_start":
        message = obj.get("message")
        if isinstance(message, dict):
            view.role = message.get("role") or view.role
            if isinstance(message.get("usage"), dict):
                view.usage = message["usage"]
        return True
    if anthropic_type == "content_block_start":
        block = obj.get("content_block")
        if isinstance(block, dict) and block.get("type") == "tool_use":
            view.tool_starts.append(block)
        return True
    if anthropic_type == "content_block_delta":
        return _consume_stream_delta(view, obj.get("delta"))
    if anthropic_type == "message_delta":
        delta = obj.get("delta")
        if isinstance(delta, dict):
            view.stop_reason = delta.get("stop_reason") or view.stop_reason
        if isinstance(obj.get("usage"), dict):
            view.usage = obj["usage"]
        return True
    if anthropic_type in {"content_block_stop", "message_stop", "ping"}:
        return True

    return False


def _consume_stream_delta(view: StreamView, delta: Any) -> bool:
    if not isinstance(delta, dict):
        return True
    if isinstance(delta.get("text"), str):
        view.text.append(delta["text"])
        return True
    if isinstance(delta.get("thinking"), str):
        view.thinking.append(delta["thinking"])
        return True
    if isinstance(delta.get("reasoningContent"), dict):
        reasoning = delta["reasoningContent"]
        if isinstance(reasoning.get("text"), str):
            view.thinking.append(reasoning["text"])
            return True
        return True
    if isinstance(delta.get("toolUse"), dict):
        tool_use = delta["toolUse"]
        if isinstance(tool_use.get("input"), str):
            view.tool_input_chunks.append(tool_use["input"])
        return True
    if isinstance(delta.get("partial_json"), str):
        view.tool_input_chunks.append(delta["partial_json"])
        return True
    return True


def _split_formatted_event(prefix: str, formatted: str) -> list[DetailSection]:
    lines = formatted.splitlines()
    if not lines:
        return [DetailSection(f"{prefix} summary", "", collapsed=False)]

    sections: list[DetailSection] = []
    title = f"{prefix} summary"
    body: list[str] = [lines[0]]

    def flush() -> None:
        if body:
            sections.append(
                DetailSection(
                    title,
                    "\n".join(body),
                    collapsed=_default_collapsed(title),
                )
            )

    for line in lines[1:]:
        next_title = _line_section_title(prefix, line)
        if next_title is not None:
            flush()
            title = next_title
            body = [line]
        else:
            body.append(line)
    flush()
    return sections


def _line_section_title(prefix: str, line: str) -> str | None:
    if not line.startswith("  ") or line.startswith("    "):
        return None
    stripped = line.strip()
    if ":" not in stripped:
        return None
    label = stripped.split(":", 1)[0]
    if stripped.endswith(":") or label in {"usage", "metrics", "stopReason", "stop_reason", "response_model", "stop"}:
        return f"{prefix} {_humanize_label(label)}"
    return None


def _humanize_label(label: str) -> str:
    replacements = {
        "raw request body": "raw request body",
        "raw response body": "raw response body",
        "raw event stream": "raw event stream",
        "request JSON": "request JSON",
        "response JSON": "response JSON",
    }
    return replacements.get(label, label.replace("_", " "))


def _default_collapsed(title: str) -> bool:
    lower = title.lower()
    return any(
        marker in lower
        for marker in (
            "headers",
            "raw",
            "system",
            "tools",
            "request json",
            "response json",
        )
    )


def run_textual(events_path: str, raw: bool = False, dedupe: bool = True) -> None:
    try:
        from textual.app import App, ComposeResult
        from textual.binding import Binding
        from textual.containers import Horizontal
        from textual.geometry import Size
        from textual.scroll_view import ScrollView
        from textual.strip import Strip
        from rich.segment import Segment
        from rich.style import Style
        from textual.widgets import DataTable, Footer, Static
    except ModuleNotFoundError as exc:
        raise SystemExit("agent_spy_tui requires Textual; rebuild/provision the firewall VM") from exc

    class SpyKeyMixin:
        async def _on_key(self, event: Any) -> None:
            if self._handle_spy_key(event):
                return
            await super()._on_key(event)

        def _handle_spy_key(self, event: Any) -> bool:
            key = event.key
            name = getattr(event, "name", key)
            if key == "j" or name == "j":
                event.stop()
                self.app.action_next_section()
                return True
            if key == "k" or name == "k":
                event.stop()
                self.app.action_previous_section()
                return True
            if key == "h" or name == "h":
                event.stop()
                self.app.action_collapse_current_section()
                return True
            if key == "l" or name == "l":
                event.stop()
                self.app.action_expand_current_section()
                return True
            if key == "t" or name == "t":
                event.stop()
                self.app.action_toggle_time_mode()
                return True
            if key in {",", "comma"} or name in {",", "comma"}:
                event.stop()
                self.app.action_narrow_nav()
                return True
            if key in {".", "period"} or name in {".", "period"}:
                event.stop()
                self.app.action_widen_nav()
                return True
            if key in {"enter", "space"} or name in {"enter", "space"}:
                event.stop()
                self.app.action_toggle_current_section()
                return True
            if key == "ctrl+left" or name == "ctrl_left":
                event.stop()
                self.app.action_narrow_nav()
                return True
            if key == "ctrl+right" or name == "ctrl_right":
                event.stop()
                self.app.action_widen_nav()
                return True
            return False

        def key_j(self, event: Any) -> None:
            event.stop()
            self.app.action_next_section()

        def key_k(self, event: Any) -> None:
            event.stop()
            self.app.action_previous_section()

        def key_h(self, event: Any) -> None:
            event.stop()
            self.app.action_collapse_current_section()

        def key_l(self, event: Any) -> None:
            event.stop()
            self.app.action_expand_current_section()

        def key_t(self, event: Any) -> None:
            event.stop()
            self.app.action_toggle_time_mode()

        def key_enter(self, event: Any) -> None:
            event.stop()
            self.app.action_toggle_current_section()

        def key_space(self, event: Any) -> None:
            event.stop()
            self.app.action_toggle_current_section()

    class SpyDataTable(SpyKeyMixin, DataTable):
        pass

    class DetailView(SpyKeyMixin, ScrollView):
        _BLANK = True
        can_focus = True

        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            self.flow_id = ""
            self.call_index: int | None = None
            self.sections: list[DetailSection] = []
            self._collapsed: list[bool] = []
            self._body_lines: list[list[str]] = []
            self._line_refs: list[tuple[str, int | None, int | None]] = []
            self._section_rows: list[int] = []
            self.active_section = 0
            self._base_style = Style()
            self._section_style = Style(bold=True)
            self._active_section_style = Style(reverse=True, bold=True)

        def set_call(self, call: CallPair | None) -> None:
            if call is None:
                self.flow_id = ""
                self.call_index = None
                self.sections = []
                self._collapsed = []
                self._body_lines = [["Waiting for Bedrock Runtime traffic..."]]
                self.active_section = 0
                self._rebuild_lines(waiting=True)
                self.scroll_home(animate=False, immediate=True)
                return

            same_call = self.call_index == call.index
            old_keys = self._collapse_state_by_key()
            self.call_index = call.index
            self.flow_id = call.flow_id
            self.sections = sections_for_call(call)
            self._body_lines = [section.body.expandtabs(4).splitlines() or [""] for section in self.sections]
            self._collapsed = []
            counts: dict[str, int] = {}
            for section in self.sections:
                key = self._section_key(section.title, counts)
                self._collapsed.append(old_keys.get(key, section.collapsed) if same_call else section.collapsed)
            self.active_section = max(0, min(self.active_section if same_call else 0, len(self.sections) - 1))
            self._rebuild_lines()
            if same_call:
                self._keep_active_section_visible()
            else:
                self.scroll_home(animate=False, immediate=True)

        def _collapse_state_by_key(self) -> dict[tuple[str, int], bool]:
            counts: dict[str, int] = {}
            states: dict[tuple[str, int], bool] = {}
            for section, collapsed in zip(self.sections, self._collapsed):
                states[self._section_key(section.title, counts)] = collapsed
            return states

        def _section_key(self, title: str, counts: dict[str, int]) -> tuple[str, int]:
            ordinal = counts.get(title, 0)
            counts[title] = ordinal + 1
            return (title, ordinal)

        def _rebuild_lines(self, *, waiting: bool = False) -> None:
            self._line_refs = []
            self._section_rows = []
            max_width = 1

            if waiting:
                text = self._body_lines[0][0]
                self._line_refs.append(("body", 0, 0))
                self.virtual_size = Size(len(text), 1)
                self.refresh()
                return

            header = f"flow_id={self.flow_id}"
            self._line_refs.append(("meta", None, None))
            max_width = max(max_width, len(header))
            if self.sections:
                self._line_refs.append(("blank", None, None))

            for index, section in enumerate(self.sections):
                self._section_rows.append(len(self._line_refs))
                self._line_refs.append(("section", index, None))
                max_width = max(max_width, len(section.title) + 4)
                if self._collapsed[index]:
                    continue
                for line_index, line in enumerate(self._body_lines[index]):
                    self._line_refs.append(("body", index, line_index))
                    max_width = max(max_width, len(line))
                self._line_refs.append(("blank", None, None))

            self.virtual_size = Size(max_width, max(1, len(self._line_refs)))
            self.refresh()

        def render_line(self, y: int) -> Strip:
            scroll_x, scroll_y = self.scroll_offset
            index = scroll_y + y
            width = max(0, self.size.width)
            if index < 0 or index >= len(self._line_refs) or width <= 0:
                return Strip.blank(width, self._base_style)

            kind, section_index, line_index = self._line_refs[index]
            if kind == "blank":
                return Strip.blank(width, self._base_style)
            if kind == "meta":
                return self._strip_text(f"flow_id={self.flow_id}", width, scroll_x, self._base_style)
            if kind == "section" and section_index is not None:
                marker = "+" if self._collapsed[section_index] else "-"
                cursor = ">" if section_index == self.active_section else " "
                text = f"{cursor} {marker} {self.sections[section_index].title}"
                style = self._active_section_style if section_index == self.active_section else self._section_style
                return self._strip_text(text, width, scroll_x, style)
            if kind == "body" and section_index is not None and line_index is not None:
                try:
                    text = self._body_lines[section_index][line_index]
                except IndexError:
                    text = ""
                return self._strip_text(text, width, scroll_x, self._base_style)
            return Strip.blank(width, self._base_style)

        def _strip_text(self, text: str, width: int, scroll_x: int, style: Style) -> Strip:
            visible = text[scroll_x : scroll_x + width] if scroll_x > 0 else text[:width]
            return Strip([Segment(visible, style)]).adjust_cell_length(width, style)

        def move_section(self, offset: int) -> None:
            if not self.sections:
                return
            target = max(0, min(self.active_section + offset, len(self.sections) - 1))
            if target == self.active_section:
                return
            self.active_section = target
            self.focus()
            self._keep_active_section_visible()
            self.refresh()

        def collapse_current(self) -> None:
            if not self.sections:
                return
            self._collapsed[self.active_section] = True
            self._rebuild_lines()
            self._keep_active_section_visible()

        def expand_current(self) -> None:
            if not self.sections:
                return
            self._collapsed[self.active_section] = False
            self._rebuild_lines()
            self._keep_active_section_visible()

        def toggle_current(self) -> None:
            if not self.sections:
                return
            self._collapsed[self.active_section] = not self._collapsed[self.active_section]
            self._rebuild_lines()
            self._keep_active_section_visible()

        def collapse_all(self) -> None:
            if not self.sections:
                return
            self._collapsed = [True for _ in self.sections]
            self._rebuild_lines()
            self._keep_active_section_visible()

        def expand_all(self) -> None:
            if not self.sections:
                return
            self._collapsed = [False for _ in self.sections]
            self._rebuild_lines()
            self._keep_active_section_visible()

        def _keep_active_section_visible(self) -> None:
            if not self._section_rows:
                return
            row = self._section_rows[self.active_section]
            height = max(1, self.size.height)
            scroll_y = self._scroll_y()
            if row < scroll_y or row >= scroll_y + height:
                self.scroll_to(y=row, animate=False, immediate=True)

        def _scroll_y(self) -> int:
            offset = self.scroll_offset
            if hasattr(offset, "y"):
                return int(offset.y)
            return int(offset[1])

        def on_mouse_down(self, event: Any) -> None:
            row = self._scroll_y() + event.y
            if 0 <= row < len(self._line_refs):
                kind, section_index, _line_index = self._line_refs[row]
                if kind in {"section", "body"} and section_index is not None:
                    self.active_section = section_index
                    self.focus()
                    self.refresh()
                    event.stop()

    class Splitter(SpyKeyMixin, Static):
        def on_mouse_down(self, event: Any) -> None:
            self.capture_mouse()
            self.add_class("dragging")
            self.app.resize_nav_to_screen_x(event.screen_x if event.screen_x is not None else event.x)
            event.stop()

        def on_mouse_move(self, event: Any) -> None:
            if self.has_class("dragging"):
                self.app.resize_nav_to_screen_x(event.screen_x if event.screen_x is not None else event.x)
                event.stop()

        def on_mouse_up(self, event: Any) -> None:
            if self.has_class("dragging"):
                self.remove_class("dragging")
                self.release_mouse()
                event.stop()

    class SpyTuiApp(App[None]):
        NAV_MIN_WIDTH = 32
        NAV_MAX_WIDTH = 100
        NAV_STEP = 4
        CALL_COLUMNS = ("time", "status", "op", "model", "in", "out")

        CSS = """
        #main {
            height: 1fr;
        }

        #calls {
            height: 1fr;
        }

        #splitter {
            width: 1;
            height: 1fr;
            background: $surface-lighten-1;
        }

        #splitter:hover, #splitter.dragging {
            background: $accent;
        }

        #details {
            width: 1fr;
            height: 1fr;
            padding: 0 1;
        }
        """

        BINDINGS = [
            Binding("q", "quit", "Quit"),
            Binding("]", "next_call", "Next pair"),
            Binding("[", "previous_call", "Prev pair"),
            Binding("j", "next_section", "Next section", priority=True),
            Binding("k", "previous_section", "Prev section", priority=True),
            Binding("down", "scroll_detail_down", "Scroll down", priority=True),
            Binding("up", "scroll_detail_up", "Scroll up", priority=True),
            Binding("enter", "toggle_current_section", "Toggle section", priority=True),
            Binding("space", "toggle_current_section", "Toggle section", priority=True),
            Binding("ctrl+left", "narrow_nav", "Narrow nav"),
            Binding("ctrl+right", "widen_nav", "Widen nav"),
            Binding("comma", "narrow_nav", "Narrow nav"),
            Binding("period", "widen_nav", "Widen nav"),
            Binding("h", "collapse_current_section", "Collapse section", priority=True),
            Binding("l", "expand_current_section", "Expand section", priority=True),
            Binding("t", "toggle_time_mode", "Local/UTC", priority=True),
            Binding("c", "collapse_all", "Collapse"),
            Binding("e", "expand_all", "Expand"),
        ]

        def __init__(self, path: str, raw: bool, dedupe: bool) -> None:
            super().__init__()
            self.reader = SpyEventReader(path)
            self.pairs = EventPairStore(raw=raw, dedupe=dedupe)
            self.selected_index = 0
            self.nav_width = 58
            self.time_mode = "utc"
            self.time_heading = ""
            self.rendered_detail_call_index: int | None = None

        def compose(self) -> ComposeResult:
            with Horizontal(id="main"):
                yield SpyDataTable(id="calls")
                yield Splitter("", id="splitter")
                yield DetailView(id="details")
            yield Footer()

        def on_mount(self) -> None:
            table = self.query_one("#calls", DataTable)
            table.cursor_type = "row"
            table.zebra_stripes = True
            self.configure_call_columns(table)
            table.focus()
            self.set_nav_width(self.nav_width)
            self.set_interval(0.2, self.poll_events)
            self.render_details()

        def configure_call_columns(self, table: DataTable) -> None:
            heading = time_column_label(self.time_mode)
            if self.time_heading == heading:
                return
            table.clear(columns=True)
            table.add_columns(
                (heading, "time"),
                ("Status", "status"),
                ("Op", "op"),
                ("Model", "model"),
                ("In", "in"),
                ("Out", "out"),
            )
            self.time_heading = heading
            for call in self.pairs.calls:
                table.add_row(*call_row(call, self.time_mode), key=str(call.index))

        def clamp_nav_width(self, width: int) -> int:
            max_for_terminal = max(self.NAV_MIN_WIDTH, self.size.width - 30)
            max_width = min(self.NAV_MAX_WIDTH, max_for_terminal)
            return max(self.NAV_MIN_WIDTH, min(width, max_width))

        def set_nav_width(self, width: int) -> None:
            self.nav_width = self.clamp_nav_width(width)
            self.query_one("#calls", DataTable).styles.width = self.nav_width

        def resize_nav_to_screen_x(self, screen_x: float) -> None:
            table = self.query_one("#calls", DataTable)
            self.set_nav_width(int(round(screen_x - table.region.x)))

        def poll_events(self) -> None:
            events = self.reader.read_available()
            if not events:
                return
            selected_before = self.selected_call_index()
            changed_selected = self.rendered_detail_call_index is None
            for event in events:
                call = self.pairs.add_event(event)
                self.upsert_call_row(call)
                changed_selected = changed_selected or call.index == selected_before
            if self.pairs.calls:
                self.selected_index = max(0, min(self.selected_index, len(self.pairs.calls) - 1))
                self.query_one("#calls", DataTable).move_cursor(row=self.selected_index)
            if changed_selected:
                self.render_details()

        def refresh_calls(self) -> None:
            table = self.query_one("#calls", DataTable)
            self.configure_call_columns(table)
            table.clear(columns=False)
            for call in self.pairs.calls:
                table.add_row(*call_row(call, self.time_mode), key=str(call.index))
            if self.pairs.calls:
                self.selected_index = max(0, min(self.selected_index, len(self.pairs.calls) - 1))
                table.move_cursor(row=self.selected_index)

        def upsert_call_row(self, call: CallPair) -> None:
            table = self.query_one("#calls", DataTable)
            self.configure_call_columns(table)
            row_key = str(call.index)
            row = call_row(call, self.time_mode)
            try:
                table.get_row(row_key)
            except Exception:
                table.add_row(*row, key=row_key)
                return
            for column, value in zip(self.CALL_COLUMNS, row):
                table.update_cell(row_key, column, value)

        def selected_call_index(self) -> int | None:
            if not self.pairs.calls:
                return None
            self.selected_index = max(0, min(self.selected_index, len(self.pairs.calls) - 1))
            return self.pairs.calls[self.selected_index].index

        def render_details(self) -> None:
            details = self.query_one("#details", DetailView)
            self.rendered_detail_call_index = None
            if not self.pairs.calls:
                details.set_call(None)
                return

            call = self.pairs.calls[self.selected_index]
            self.rendered_detail_call_index = call.index
            details.set_call(call)

        def action_next_call(self) -> None:
            self.select_call(self.selected_index + 1)

        def action_previous_call(self) -> None:
            self.select_call(self.selected_index - 1)

        def select_call(self, index: int, *, move_cursor: bool = True) -> None:
            if not self.pairs.calls:
                return
            self.selected_index = max(0, min(index, len(self.pairs.calls) - 1))
            if move_cursor:
                table = self.query_one("#calls", DataTable)
                table.move_cursor(row=self.selected_index)
            self.render_details()

        def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
            self.select_call_from_table_event(event)

        def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
            self.select_call_from_table_event(event)

        def on_key(self, event: Any) -> None:
            if event.key == "j":
                event.stop()
                self.action_next_section()
            elif event.key == "k":
                event.stop()
                self.action_previous_section()
            elif event.key == "h":
                event.stop()
                self.action_collapse_current_section()
            elif event.key == "l":
                event.stop()
                self.action_expand_current_section()
            elif event.key == "t":
                event.stop()
                self.action_toggle_time_mode()
            elif event.key in {"enter", "space"}:
                event.stop()
                self.action_toggle_current_section()
            elif event.key in {",", "comma"} or getattr(event, "name", None) == "comma":
                event.stop()
                self.action_narrow_nav()
            elif event.key in {".", "period"} or getattr(event, "name", None) == "period":
                event.stop()
                self.action_widen_nav()
            elif event.key == "ctrl+left" or getattr(event, "name", None) == "ctrl_left":
                event.stop()
                self.action_narrow_nav()
            elif event.key == "ctrl+right" or getattr(event, "name", None) == "ctrl_right":
                event.stop()
                self.action_widen_nav()

        def select_call_from_table_event(self, event: DataTable.RowHighlighted | DataTable.RowSelected) -> None:
            if event.data_table.id != "calls":
                return
            index = self.index_for_row_event(event)
            if index is not None:
                self.select_call(index, move_cursor=False)

        def index_for_row_event(self, event: DataTable.RowHighlighted | DataTable.RowSelected) -> int | None:
            row_key_value = getattr(event.row_key, "value", None)
            if row_key_value is not None:
                for index, call in enumerate(self.pairs.calls):
                    if str(call.index) == str(row_key_value):
                        return index
            if 0 <= event.cursor_row < len(self.pairs.calls):
                return event.cursor_row
            return None

        def action_next_section(self) -> None:
            self.detail_view().move_section(1)

        def action_previous_section(self) -> None:
            self.detail_view().move_section(-1)

        def action_scroll_detail_down(self) -> None:
            self.detail_view().scroll_down(animate=False, immediate=True)

        def action_scroll_detail_up(self) -> None:
            self.detail_view().scroll_up(animate=False, immediate=True)

        def action_narrow_nav(self) -> None:
            self.set_nav_width(self.nav_width - self.NAV_STEP)

        def action_widen_nav(self) -> None:
            self.set_nav_width(self.nav_width + self.NAV_STEP)

        def action_collapse_current_section(self) -> None:
            self.detail_view().collapse_current()

        def action_expand_current_section(self) -> None:
            self.detail_view().expand_current()

        def action_toggle_current_section(self) -> None:
            self.detail_view().toggle_current()

        def action_toggle_time_mode(self) -> None:
            self.time_mode = "local" if self.time_mode == "utc" else "utc"
            self.time_heading = ""
            self.refresh_calls()

        def action_collapse_all(self) -> None:
            self.detail_view().collapse_all()

        def action_expand_all(self) -> None:
            self.detail_view().expand_all()

        def detail_view(self) -> DetailView:
            return self.query_one("#details", DetailView)

    SpyTuiApp(events_path, raw, dedupe).run()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Browse Bedrock traffic captured by agent spy.")
    parser.add_argument("--events", default=agent_spy.SPY_EVENTS, help="path to the NDJSON event stream")
    parser.add_argument("--raw", action="store_true", help="include sanitized raw JSON bodies")
    parser.add_argument("--no-dedupe", action="store_true", help="do not elide repeated cache-marked prompt prefixes")
    args = parser.parse_args(argv)

    run_textual(args.events, raw=args.raw, dedupe=not args.no_dedupe)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
