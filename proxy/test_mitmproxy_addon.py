import os
import sys
import tempfile
import types
import unittest


class OptionsError(Exception):
    pass


mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.ctx = types.SimpleNamespace(
    options=types.SimpleNamespace(connection_strategy="lazy")
)
mitmproxy.exceptions = types.SimpleNamespace(OptionsError=OptionsError)
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object)
mitmproxy.tls = types.SimpleNamespace(ClientHelloData=object)
sys.modules["mitmproxy"] = mitmproxy

sys.path.insert(0, os.path.dirname(__file__))
import mitmproxy_addon


class MitmproxyAddonTests(unittest.TestCase):
    def setUp(self):
        mitmproxy_addon.logger.disabled = True
        self._allow_https = mitmproxy_addon.ALLOW_HTTPS
        self._https_cache = mitmproxy_addon._https_cache
        mitmproxy_addon._https_cache = mitmproxy_addon._HttpsPolicyCache()

    def tearDown(self):
        mitmproxy_addon.ALLOW_HTTPS = self._allow_https
        mitmproxy_addon._https_cache = self._https_cache
        mitmproxy_addon.ctx.options.connection_strategy = "lazy"
        mitmproxy_addon.logger.disabled = False

    def test_cache_normalizes_allowlist_entries_to_lowercase(self):
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            path = f.name
            f.write("Example.COM\n")
            f.write("  *.GitHubUserContent.COM  \n")
            f.write("  # Comment\n")

        try:
            cache = mitmproxy_addon._StringSetCache()
            self.assertEqual(
                cache.get(path),
                {"example.com", "*.githubusercontent.com"},
            )
        finally:
            os.unlink(path)

    def test_matches_is_case_insensitive_for_hosts_and_patterns(self):
        self.assertTrue(mitmproxy_addon._matches("example.com", {"Example.COM"}))
        self.assertTrue(mitmproxy_addon._matches("API.GITHUB.COM", {"*.github.com"}))

    def test_https_policy_host_only_entries_allow_all_paths(self):
        policy = self._https_policy("github.com\n")

        self.assertTrue(policy.allows_request("github.com", "GET /rootcell-ai/rootcell"))
        self.assertTrue(policy.allows_request("GITHUB.COM", "POST /anything"))

    def test_https_policy_scoped_entries_allow_matching_paths(self):
        policy = self._https_policy(
            r"github.com ^GET /rootcell-ai/(rootcell|docs)\.git/.*"
            "\n"
        )

        self.assertTrue(
            policy.allows_request(
                "github.com",
                "GET /rootcell-ai/rootcell.git/info/refs?service=git-upload-pack",
            )
        )

    def test_https_policy_scoped_entries_deny_nonmatching_paths(self):
        policy = self._https_policy(
            r"github.com ^GET /rootcell-ai/rootcell\.git/.*"
            "\n"
        )

        self.assertFalse(
            policy.allows_request(
                "github.com",
                "GET /other-org/other.git/info/refs?service=git-upload-pack",
            )
        )

    def test_https_policy_scoped_entries_dominate_unscoped_entries(self):
        policy = self._https_policy(
            "github.com\n"
            r"github.com ^GET /rootcell-ai/rootcell\.git/.*"
            "\n"
        )

        self.assertFalse(policy.allows_request("github.com", "GET /other/repo.git/info/refs"))
        self.assertTrue(policy.allows_request("github.com", "GET /rootcell-ai/rootcell.git/info/refs"))

    def test_https_policy_invalid_regex_fails_closed(self):
        policy = self._https_policy("github.com [\n")

        self.assertFalse(policy.valid)
        self.assertFalse(policy.allows_host("github.com"))
        self.assertFalse(policy.allows_request("github.com", "GET /rootcell-ai/rootcell"))

    def test_tls_clienthello_allows_scoped_hosts_by_hostname(self):
        path = self._write_temp_policy(r"github.com ^GET /rootcell-ai/rootcell\.git/.*" "\n")
        mitmproxy_addon.ALLOW_HTTPS = path
        data = _client_hello("github.com")

        try:
            mitmproxy_addon.tls_clienthello(data)

            self.assertFalse(data.ignore_connection)
            self.assertEqual(data.context.server.address, ("github.com", 443))
        finally:
            os.unlink(path)

    def test_request_hook_denies_scoped_host_when_regex_does_not_match(self):
        path = self._write_temp_policy(r"github.com ^GET /rootcell-ai/rootcell\.git/.*" "\n")
        mitmproxy_addon.ALLOW_HTTPS = path
        flow = _flow("github.com", "github.com", "GET", "/other/repo.git/info/refs")

        try:
            mitmproxy_addon.request(flow)

            self.assertTrue(flow.killed)
        finally:
            os.unlink(path)

    def test_request_hook_allows_scoped_host_when_regex_matches(self):
        path = self._write_temp_policy(r"github.com ^GET /rootcell-ai/rootcell\.git/.*" "\n")
        mitmproxy_addon.ALLOW_HTTPS = path
        flow = _flow("github.com", "github.com", "GET", "/rootcell-ai/rootcell.git/info/refs")

        try:
            mitmproxy_addon.request(flow)

            self.assertFalse(flow.killed)
        finally:
            os.unlink(path)

    def test_load_accepts_lazy_connection_strategy(self):
        mitmproxy_addon.ctx.options.connection_strategy = "lazy"
        mitmproxy_addon.load(None)

    def test_load_rejects_non_lazy_connection_strategy(self):
        mitmproxy_addon.ctx.options.connection_strategy = "eager"
        with self.assertRaises(OptionsError) as raised:
            mitmproxy_addon.load(None)

        self.assertIn("connection_strategy=lazy", str(raised.exception))

    def test_configure_rejects_connection_strategy_update_to_non_lazy(self):
        mitmproxy_addon.ctx.options.connection_strategy = "eager"
        with self.assertRaises(OptionsError):
            mitmproxy_addon.configure({"connection_strategy"})

    def _https_policy(self, content):
        path = self._write_temp_policy(content)
        try:
            return mitmproxy_addon._parse_https_policy(path)
        finally:
            os.unlink(path)

    def _write_temp_policy(self, content):
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write(content)
            return f.name


def _flow(sni, host, method, path):
    flow = types.SimpleNamespace(
        client_conn=types.SimpleNamespace(sni=sni),
        request=types.SimpleNamespace(
            pretty_host=host,
            method=method,
            path=path,
        ),
        killed=False,
    )

    def kill():
        flow.killed = True

    flow.kill = kill
    return flow


def _client_hello(sni):
    return types.SimpleNamespace(
        client_hello=types.SimpleNamespace(sni=sni),
        context=types.SimpleNamespace(
            server=types.SimpleNamespace(address=(sni, 443)),
        ),
        ignore_connection=False,
    )


if __name__ == "__main__":
    unittest.main()
