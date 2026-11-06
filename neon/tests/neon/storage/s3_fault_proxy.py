"""Loopback-only S3 test proxy with a controlled outage and verified TLS upstream.

Requests are re-signed for the real endpoint. This avoids disabling TLS checking
or changing server DNS while exercising the application's real S3 retry paths.
"""
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import urllib.parse
from s3_client import S3Client, S3Error


class S3FaultProxy:
    def __init__(self, config, port=19091):
        client = S3Client(config)
        self.outage = threading.Event()
        self.counts = Counter()
        lock = threading.Lock()
        state = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_args):
                # The AWS Authorization header and URL must never enter logs.
                pass

            def handle_request(self):
                with lock:
                    state.counts[self.command] += 1
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 <= length <= 256 * 1024 * 1024:
                    self.send_error(413)
                    return
                if self.headers.get('Transfer-Encoding'):
                    # The pinned Neon SDK uses known-length files. Fail rather
                    # than silently forwarding an unparsed streaming payload.
                    self.send_error(501)
                    return
                data = self.rfile.read(length)
                if state.outage.is_set():
                    with lock:
                        state.counts['injected_503'] += 1
                    self.respond(503, b'<Error><Code>ServiceUnavailable</Code></Error>', {})
                    return
                url = urllib.parse.urlsplit(self.path)
                path = urllib.parse.unquote(url.path).split('/', 2)
                query = dict(urllib.parse.parse_qsl(url.query, keep_blank_values=True))
                key = path[2] if len(path) == 3 else ''
                if len(path) < 2 or path[1] != config['bucket'] or (
                    key and not key.startswith(config['prefix'] + '/')
                ) or (not key and self.command not in ('GET', 'HEAD')) or (
                    not key and self.command == 'GET' and not query.get('prefix', '').startswith(config['prefix'] + '/')
                ) or (query.get('prefix') and not query['prefix'].startswith(config['prefix'] + '/')):
                    self.send_error(403)
                    return
                allowed = ('range', 'if-match', 'if-none-match', 'content-type',
                           'x-amz-copy-source', 'x-amz-metadata-directive', 'x-amz-storage-class')
                headers = {name: self.headers[name] for name in allowed if name in self.headers}
                copy_source = urllib.parse.unquote(headers.get('x-amz-copy-source', ''))
                if copy_source and not copy_source.startswith('/' + config['bucket'] + '/' + config['prefix'] + '/'):
                    self.send_error(403)
                    return
                try:
                    status, body, response_headers = client.request(self.command, key, data, query, headers)
                    with lock:
                        state.counts['upstream_success'] += 1
                        if self.command == 'GET':
                            state.counts['upstream_get_bytes'] += len(body)
                except S3Error as error:
                    status, body, response_headers = error.status, error.body, error.headers
                    with lock:
                        state.counts[f'upstream_http_{status}'] += 1
                self.respond(status, body, response_headers)

            def respond(self, status, body, headers):
                self.send_response(status)
                for name, value in headers.items():
                    if name.lower() in ('etag', 'content-type', 'content-range', 'last-modified', 'x-amz-version-id'):
                        self.send_header(name, value)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if self.command != 'HEAD':
                    try:
                        self.wfile.write(body)
                    except (BrokenPipeError, ConnectionResetError):
                        pass

            do_GET = do_PUT = do_POST = do_DELETE = do_HEAD = handle_request

        self.server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = f'http://127.0.0.1:{self.server.server_port}'

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=10)
