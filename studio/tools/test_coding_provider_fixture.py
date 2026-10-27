# SPDX-License-Identifier: AGPL-3.0-only
import concurrent.futures
import json
import unittest
import urllib.error
import urllib.request

from coding_provider_fixture import ProviderFixture


def post(fixture, body):
    request = urllib.request.Request(
        fixture.base_url + '/chat/completions',
        data=body,
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


class ProviderRequestSizeTests(unittest.TestCase):
    def test_large_history_reaches_configured_fixture(self):
        body = json.dumps({'messages': [{'role': 'assistant', 'content': 'large history' * 1024}]}).encode()
        fixture = ProviderFixture(max_request_bytes=len(body))
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                response = executor.submit(post, fixture, body)
                received = fixture.request(timeout=5)
                self.assertEqual(received.body, json.loads(body))
                received.text('accepted')
                self.assertEqual(response.result(timeout=10), 200)
        finally:
            fixture.close()

    def test_request_above_configured_bound_is_rejected(self):
        fixture = ProviderFixture(max_request_bytes=8)
        try:
            self.assertEqual(post(fixture, b'{"messages": []}'), 413)
            fixture.assert_no_request()
        finally:
            fixture.close()


if __name__ == '__main__':
    unittest.main()
