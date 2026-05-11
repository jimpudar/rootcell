import base64
import binascii
import json
import os
import sys
import struct
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import agent_spy


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


class AgentSpyTests(unittest.TestCase):
    def test_detects_bedrock_runtime_paths(self):
        info = agent_spy.detect_bedrock_request(
            "bedrock-runtime.us-west-2.amazonaws.com",
            "/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse-stream",
        )
        self.assertIsNotNone(info)
        self.assertEqual(info["operation"], "converse-stream")
        self.assertEqual(info["model_id"], "anthropic.claude-3-5-sonnet-20241022-v2:0")

        fips = agent_spy.detect_bedrock_request(
            "bedrock-runtime-fips.us-gov-west-1.amazonaws.com",
            "/model/anthropic.claude/invoke",
        )
        self.assertIsNotNone(fips)
        self.assertIsNone(
            agent_spy.detect_bedrock_request(
                "api.anthropic.com",
                "/model/anthropic.claude/invoke",
            )
        )

    def test_redacts_auth_headers(self):
        headers = agent_spy.redact_headers(
            [
                ("Authorization", "AWS4-HMAC-SHA256 Credential=AKIA/..., Signature=abc"),
                ("X-Amz-Security-Token", "secret"),
                ("Content-Type", "application/json"),
            ]
        )
        self.assertEqual(headers[0][1], "[redacted]")
        self.assertEqual(headers[1][1], "[redacted]")
        self.assertEqual(headers[2][1], "application/json")

    def test_binary_fields_are_summarized(self):
        raw = b"not really a png but enough bytes" * 4
        body = {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": base64.b64encode(raw).decode("ascii"),
            },
        }
        summarized = agent_spy.summarize_binary_fields(body)
        self.assertIn("image/png base64", summarized["source"]["data"])
        self.assertIn("sha256:", summarized["source"]["data"])

    def test_converse_formatting_and_cache_dedupe(self):
        formatter = agent_spy.SpyFormatter()
        event = {
            "ts": 1,
            "direction": "request",
            "provider": "bedrock",
            "operation": "converse",
            "model_id": "anthropic.claude",
            "host": "bedrock-runtime.us-east-1.amazonaws.com",
            "method": "POST",
            "path": "/model/anthropic.claude/converse",
            "headers": [["Content-Type", "application/json"]],
            "body_text": json.dumps(
                {
                    "system": [{"text": "system prompt"}, {"cachePoint": {"type": "default"}}],
                    "messages": [{"role": "user", "content": [{"text": "dynamic question"}]}],
                    "toolConfig": {
                        "tools": [
                            {
                                "toolSpec": {
                                    "name": "shell",
                                    "description": "run commands",
                                    "inputSchema": {"json": {"type": "object"}},
                                }
                            }
                        ]
                    },
                }
            ),
        }

        first = formatter.format_event(event)
        second = formatter.format_event(event)
        self.assertIn("system prompt", first)
        self.assertIn("dynamic question", first)
        self.assertIn("tools:", first)
        self.assertIn("cached prefix", second)
        self.assertNotIn("system prompt", second)
        self.assertIn("dynamic question", second)

    def test_claude_invoke_formatting(self):
        formatter = agent_spy.SpyFormatter(raw=True)
        event = {
            "ts": 1,
            "direction": "request",
            "provider": "bedrock",
            "operation": "invoke",
            "model_id": "anthropic.claude",
            "host": "bedrock-runtime.us-east-1.amazonaws.com",
            "method": "POST",
            "path": "/model/anthropic.claude/invoke",
            "headers": [["Content-Type", "application/json"]],
            "body_text": json.dumps(
                {
                    "anthropic_version": "bedrock-2023-05-31",
                    "system": [{"type": "text", "text": "be useful", "cache_control": {"type": "ephemeral"}}],
                    "messages": [
                        {
                            "role": "user",
                            "content": [{"type": "text", "text": "hello"}],
                        }
                    ],
                    "tools": [{"name": "lookup", "input_schema": {"type": "object"}}],
                }
            ),
        }
        out = formatter.format_event(event)
        self.assertIn("anthropic_version", out)
        self.assertIn("be useful", out)
        self.assertIn("lookup", out)
        self.assertIn("raw request body", out)

    def test_eventstream_decoding_and_formatting(self):
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
        decoded = agent_spy.decode_event_stream(stream)
        self.assertEqual(len(decoded), len(payloads))

        formatter = agent_spy.SpyFormatter()
        out = formatter.format_event(
            {
                "ts": 1,
                "direction": "response",
                "provider": "bedrock",
                "operation": "converse-stream",
                "model_id": "anthropic.claude",
                "status_code": 200,
                "headers": [["Content-Type", "application/vnd.amazon.eventstream"]],
                "body_encoding": "aws-eventstream",
                "body_b64": base64.b64encode(stream).decode("ascii"),
            }
        )
        self.assertIn("Hello world", out)
        self.assertIn("usage: input=4, output=2", out)
        self.assertIn("stop: end_turn", out)

    def test_tail_keyboard_interrupt_exits_cleanly(self):
        original = agent_spy._tail_events
        try:
            agent_spy._tail_events = lambda path, formatter: (_ for _ in ()).throw(KeyboardInterrupt())
            self.assertEqual(agent_spy.main(["tail", "--events", "/tmp/missing"]), 130)
        finally:
            agent_spy._tail_events = original


if __name__ == "__main__":
    unittest.main()
