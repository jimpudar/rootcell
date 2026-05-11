import base64
import binascii
import datetime as dt
import json
import os
import struct
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import agent_spy_tui


def request_event(flow_id="flow-1", body=None):
    return {
        "ts": 1,
        "direction": "request",
        "flow_id": flow_id,
        "provider": "bedrock",
        "operation": "converse",
        "model_id": "anthropic.claude",
        "host": "bedrock-runtime.us-east-1.amazonaws.com",
        "method": "POST",
        "path": "/model/anthropic.claude/converse",
        "headers": [["Content-Type", "application/json"]],
        "body_text": json.dumps(body or {"messages": [{"role": "user", "content": [{"text": "hello"}]}]}),
    }


def response_event(flow_id="flow-1", status=200, body=None):
    return {
        "ts": 2,
        "direction": "response",
        "flow_id": flow_id,
        "provider": "bedrock",
        "operation": "converse",
        "model_id": "anthropic.claude",
        "status_code": status,
        "reason": "OK",
        "headers": [["Content-Type", "application/json"]],
        "body_text": json.dumps(
            body
            or {
                "output": {"message": {"role": "assistant", "content": [{"text": "hi"}]}},
                "usage": {"inputTokens": 4, "outputTokens": 2},
            }
        ),
    }


def eventstream_message(headers, payload):
    header_bytes = b""
    for name, value in headers.items():
        name_bytes = name.encode("utf-8")
        value_bytes = value.encode("utf-8")
        header_bytes += bytes([len(name_bytes)]) + name_bytes
        header_bytes += bytes([7]) + struct.pack(">H", len(value_bytes)) + value_bytes

    total_len = 16 + len(header_bytes) + len(payload)
    prelude = struct.pack(">II", total_len, len(header_bytes))
    prelude_crc = struct.pack(">I", binascii.crc32(prelude) & 0xFFFFFFFF)
    without_message_crc = prelude + prelude_crc + header_bytes + payload
    message_crc = struct.pack(">I", binascii.crc32(without_message_crc) & 0xFFFFFFFF)
    return without_message_crc + message_crc


class AgentSpyTuiTests(unittest.TestCase):
    def test_pairs_request_and_response_by_flow_id(self):
        store = agent_spy_tui.EventPairStore()
        store.add_event(request_event("a"))
        store.add_event(response_event("a", status=201))

        self.assertEqual(len(store.calls), 1)
        self.assertIsNotNone(store.calls[0].request)
        self.assertIsNotNone(store.calls[0].response)
        self.assertEqual(agent_spy_tui.call_row(store.calls[0])[1], "201 OK")

    def test_pairs_response_first_and_keeps_pending_items(self):
        store = agent_spy_tui.EventPairStore()
        store.add_event(response_event("response-first"))
        store.add_event(request_event("pending"))
        store.add_event(request_event("response-first"))

        self.assertEqual(len(store.calls), 2)
        self.assertIsNotNone(store.calls[0].request)
        self.assertIsNotNone(store.calls[0].response)
        self.assertEqual(agent_spy_tui.call_row(store.calls[1])[1], "pending")

    def test_duplicate_flow_ids_do_not_overwrite_calls(self):
        store = agent_spy_tui.EventPairStore()
        store.add_event(request_event("dup", {"messages": [{"role": "user", "content": [{"text": "one"}]}]}))
        store.add_event(request_event("dup", {"messages": [{"role": "user", "content": [{"text": "two"}]}]}))
        store.add_event(response_event("dup", status=200))
        store.add_event(response_event("dup", status=202))

        self.assertEqual(len(store.calls), 2)
        self.assertEqual(agent_spy_tui.call_row(store.calls[0])[1], "200 OK")
        self.assertEqual(agent_spy_tui.call_row(store.calls[1])[1], "202 OK")
        self.assertIn("one", store.calls[0].request["_agent_spy_tui_formatted"])
        self.assertIn("two", store.calls[1].request["_agent_spy_tui_formatted"])

    def test_malformed_ndjson_becomes_error_event(self):
        event = agent_spy_tui.parse_event_line("{not-json")
        self.assertEqual(event["direction"], "error")
        self.assertIn("malformed", event["error"])

    def test_left_nav_time_format_modes(self):
        local_tz = dt.timezone(dt.timedelta(hours=-4), "EDT")

        self.assertEqual(agent_spy_tui.format_event_time(0, "utc"), "1970-01-01 00:00:00")
        self.assertEqual(
            agent_spy_tui.format_event_time(0, "local", local_tz),
            "1969-12-31 8:00:00 PM EDT",
        )

    def test_section_marker_click_hit_test_accounts_for_horizontal_scroll(self):
        self.assertTrue(agent_spy_tui.is_section_marker_click(0, 0))
        self.assertTrue(agent_spy_tui.is_section_marker_click(1, 0))
        self.assertTrue(agent_spy_tui.is_section_marker_click(2, 0))
        self.assertTrue(agent_spy_tui.is_section_marker_click(3, 0))
        self.assertTrue(agent_spy_tui.is_section_marker_click(1, 1))
        self.assertTrue(agent_spy_tui.is_section_marker_click(0, 2))
        self.assertFalse(agent_spy_tui.is_section_marker_click(4, 0))
        self.assertFalse(agent_spy_tui.is_section_marker_click(1, 3))

    def test_view_model_sections_include_system_tools_and_raw(self):
        store = agent_spy_tui.EventPairStore(raw=True)
        store.add_event(
            request_event(
                "structured",
                {
                    "system": [{"text": "system prompt"}],
                    "messages": [{"role": "user", "content": [{"text": "dynamic question"}]}],
                    "toolConfig": {
                        "tools": [
                            {
                                "toolSpec": {
                                    "name": "lookup",
                                    "description": "look things up",
                                    "inputSchema": {"json": {"type": "object"}},
                                }
                            }
                        ]
                    },
                },
            )
        )

        sections = agent_spy_tui.sections_for_call(store.calls[0])
        by_title = {section.title: section for section in sections}
        self.assertIn("system prompt", by_title["Request system"].body)
        self.assertIn("lookup", by_title["Request tools"].body)
        self.assertIn("raw request body", by_title["Request raw request body"].title)

    def test_dedupe_matches_formatter_cache_prefix_behavior(self):
        body = {
            "system": [{"text": "system prompt"}, {"cachePoint": {"type": "default"}}],
            "messages": [{"role": "user", "content": [{"text": "dynamic question"}]}],
        }
        store = agent_spy_tui.EventPairStore()
        store.add_event(request_event("first", body))
        store.add_event(request_event("second", body))

        second = "\n".join(section.body for section in agent_spy_tui.sections_for_call(store.calls[1]))
        self.assertIn("cached prefix", second)
        self.assertNotIn("system prompt", second)
        self.assertIn("dynamic question", second)

    def test_eventstream_usage_and_sections(self):
        payloads = [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockDelta": {"delta": {"text": "Hello"}}},
            {"contentBlockDelta": {"delta": {"text": " world"}}},
            {"messageStop": {"stopReason": "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 4, "outputTokens": 2}}},
        ]
        stream = b"".join(
            eventstream_message(
                {":message-type": "event", ":event-type": "chunk", ":content-type": "application/json"},
                json.dumps(payload).encode("utf-8"),
            )
            for payload in payloads
        )
        event = response_event("stream")
        event.update(
            {
                "operation": "converse-stream",
                "body_encoding": "aws-eventstream",
                "body_b64": base64.b64encode(stream).decode("ascii"),
                "body_text": None,
            }
        )
        store = agent_spy_tui.EventPairStore()
        store.add_event(event)

        self.assertEqual(agent_spy_tui.call_row(store.calls[0])[4], "4")
        self.assertEqual(agent_spy_tui.call_row(store.calls[0])[5], "2")
        rendered = "\n".join(section.body for section in agent_spy_tui.sections_for_call(store.calls[0]))
        self.assertIn("Hello world", rendered)

    def test_unwrapped_bedrock_stream_events_get_response_sections_and_tokens(self):
        payloads = [
            ("messageStart", {"p": "abcdef", "role": "assistant"}),
            ("contentBlockDelta", {"contentBlockIndex": 0, "delta": {"reasoningContent": {"text": "Simple"}}}),
            ("contentBlockDelta", {"contentBlockIndex": 0, "delta": {"reasoningContent": {"text": " acknowledgement."}}}),
            ("contentBlockStop", {"contentBlockIndex": 0}),
            ("contentBlockDelta", {"contentBlockIndex": 1, "delta": {"text": "Ready"}}),
            ("contentBlockDelta", {"contentBlockIndex": 1, "delta": {"text": " when you are!"}}),
            ("messageStop", {"stopReason": "end_turn"}),
            (
                "metadata",
                {
                    "metrics": {"latencyMs": 2334},
                    "usage": {"inputTokens": 2863, "outputTokens": 31, "totalTokens": 2894},
                },
            ),
        ]
        stream = b"".join(
            eventstream_message(
                {":message-type": "event", ":event-type": event_type, ":content-type": "application/json"},
                json.dumps(payload).encode("utf-8"),
            )
            for event_type, payload in payloads
        )
        event = response_event("stream")
        event.update(
            {
                "operation": "converse-stream",
                "headers": [
                    ["content-type", "application/vnd.amazon.eventstream"],
                    ["x-amzn-requestid", "b70a9e1d-ae69-4321-acb9-9aa1b2a6bd7c"],
                ],
                "body_encoding": "aws-eventstream",
                "body_b64": base64.b64encode(stream).decode("ascii"),
                "body_text": None,
            }
        )
        store = agent_spy_tui.EventPairStore()
        store.add_event(event)

        row = agent_spy_tui.call_row(store.calls[0])
        self.assertEqual(row[4], "2863")
        self.assertEqual(row[5], "31")

        sections = agent_spy_tui.sections_for_call(store.calls[0])
        by_title = {section.title: section for section in sections}
        self.assertIn("content-type", by_title["Response headers"].body)
        self.assertNotIn("stream messageStart", by_title["Response headers"].body)
        self.assertIn("Simple acknowledgement.", by_title["Response thinking"].body)
        self.assertIn("Ready when you are!", by_title["Response assistant"].body)
        self.assertIn("input=2863", by_title["Response usage"].body)
        self.assertIn("latencyMs", by_title["Response metrics"].body)
        self.assertEqual(by_title["Response stop"].body, "end_turn")
        self.assertNotIn("Response stream events", by_title)


if __name__ == "__main__":
    unittest.main()
