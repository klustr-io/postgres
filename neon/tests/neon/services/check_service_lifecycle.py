"""Probe only isolated qualification services; credentials arrive on stdin."""
import json
import sys
import time
import urllib.error
import urllib.request

config = json.load(sys.stdin)
for service in config['services']:
    deadline = time.monotonic() + 90
    while True:
        data = json.dumps(service['payload']).encode() if 'payload' in service else None
        headers = {'Content-Type': 'application/json'}
        if service.get('token'):
            headers['Authorization'] = 'Bearer ' + service['token']
        request = urllib.request.Request(service['url'], data=data, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                assert response.status in (200, 201)
                response.read()
            break
        except (OSError, AssertionError) as error:
            if time.monotonic() > deadline:
                raise AssertionError(service['role'] + ' did not become ready; last result: ' +
                    str(getattr(error, 'code', type(error).__name__))) from None
            time.sleep(1)
    if service.get('token'):
        try:
            urllib.request.urlopen(urllib.request.Request(service['url'], data=data,
                headers={'Content-Type': 'application/json'}), timeout=3)
        except urllib.error.HTTPError as error:
            assert error.code == 401, (service['role'], error.code)
        else:
            raise AssertionError(service['role'] + ' accepted unauthenticated request')
    print('PASS ' + service['role'] + ': actual service startup' +
          (', signed authentication and anonymous rejection' if service.get('token') else ''), flush=True)
