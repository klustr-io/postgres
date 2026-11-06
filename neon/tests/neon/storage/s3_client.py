"""Small SigV4 client for qualification probes; never includes credentials in errors."""
import datetime
import hashlib
import hmac
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


class S3Error(RuntimeError):
    def __init__(self, message, status=503, body=b'', headers=None):
        super().__init__(message)
        self.status, self.body, self.headers = status, body, headers or {}


class S3Client:
    def __init__(self, config):
        self.config = config
        self.endpoint = urllib.parse.urlsplit(config['endpoint'])

    def request(self, method, key='', data=b'', query=None, extra_headers=None):
        config = self.config
        now = datetime.datetime.now(datetime.timezone.utc)
        timestamp, date = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
        uri = self.endpoint.path.rstrip('/') + '/' + config['bucket']
        if key:
            uri += '/' + key
        uri = urllib.parse.quote(uri, safe='/~-._')
        query_string = urllib.parse.urlencode(sorted((query or {}).items()),
                                               quote_via=urllib.parse.quote, safe='~-._')
        payload_hash = hashlib.sha256(data).hexdigest()
        headers = {'host': self.endpoint.netloc, 'x-amz-date': timestamp,
                   'x-amz-content-sha256': payload_hash}
        headers.update({key.lower(): value.strip() for key, value in (extra_headers or {}).items()})
        names = ';'.join(sorted(headers))
        canonical_headers = ''.join(f'{name}:{headers[name]}\n' for name in sorted(headers))
        canonical = '\n'.join([method, uri, query_string, canonical_headers, names, payload_hash])
        scope = f'{date}/{config["region"]}/s3/aws4_request'
        to_sign = f'AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}'
        signing_key = ('AWS4' + config['secret_key']).encode()
        for value in (date, config['region'], 's3', 'aws4_request'):
            signing_key = hmac.new(signing_key, value.encode(), hashlib.sha256).digest()
        signature = hmac.new(signing_key, to_sign.encode(), hashlib.sha256).hexdigest()
        headers['Authorization'] = f'AWS4-HMAC-SHA256 Credential={config["access_key"]}/{scope}, SignedHeaders={names}, Signature={signature}'
        url = urllib.parse.urlunsplit((self.endpoint.scheme, self.endpoint.netloc, uri, query_string, ''))
        request = urllib.request.Request(url, data=data if method in ('PUT', 'POST') else None,
                                         headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return response.status, response.read(), dict(response.headers)
        except urllib.error.HTTPError as error:
            status = error.code
            body, headers = error.read(1024 * 1024), dict(error.headers)
            error.close()
            raise S3Error(f'S3 operation {method} returned HTTP {status}', status, body, headers) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise S3Error(f'S3 operation {method} failed: {type(error).__name__}') from None

    def objects(self, prefix):
        objects = []
        query = {'list-type': '2', 'prefix': prefix, 'max-keys': '1000'}
        for _ in range(100):
            _, body, _ = self.request('GET', query=query)
            root = ET.fromstring(body)
            for item in root.findall('{*}Contents'):
                objects.append({'key': item.findtext('{*}Key'), 'size': int(item.findtext('{*}Size'))})
            if root.findtext('{*}IsTruncated') != 'true':
                return objects
            query['continuation-token'] = root.findtext('{*}NextContinuationToken')
            assert query['continuation-token'], 'Missing S3 continuation token'
        raise S3Error('Qualification prefix exceeded pagination limit')
