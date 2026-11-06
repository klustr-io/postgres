import base64
import copy
import hashlib
import unittest
import xml.etree.ElementTree as ET
from remove_s3_test_storage import execute


def fixture():
    targets = []
    for i in range(38):
        prefix = f'neon-pg18-benchmark/20261031000000000-{i:08x}-0000-0000-0000-000000000000/'
        targets.append({'prefix': prefix, 'objects': [{'key': prefix + 'old-test-data',
            'size': 7, 'etag': '"owned"', 'version_id': None, 'delete_marker': False}]})
    return {'status': 'PLAN-ONLY-AWAITING-EXPLICIT-REMOTE-DATA-DELETION-APPROVAL',
            'versioning': 'Disabled', 'targets': targets, 'total_entries': 38, 'total_bytes': 266}


class Client:
    def __init__(self, plan):
        self.rows = {row['prefix']: copy.deepcopy(row['objects']) for row in plan['targets']}
        self.deletes = []
        self.versioning = ''

    def request(self, method, key='', data=b'', query=None, extra_headers=None):
        if method == 'GET' and 'versioning' in query:
            return 200, f'<VersioningConfiguration>{self.versioning}</VersioningConfiguration>'.encode(), {}
        if method == 'GET':
            root = ET.Element('ListBucketResult')
            for row in self.rows[query['prefix']]:
                item = ET.SubElement(root, 'Contents')
                for name, value in [('Key', row['key']), ('Size', row['size']), ('ETag', row['etag'])]:
                    ET.SubElement(item, name).text = str(value)
            return 200, ET.tostring(root), {}
        assert method == 'POST' and query == {'delete': ''}
        assert extra_headers['Content-MD5'] == base64.b64encode(hashlib.md5(data).digest()).decode()
        keys = [item.findtext('{*}Key') for item in ET.fromstring(data).findall('{*}Object')]
        root = ET.Element('DeleteResult')
        for item_key in keys:
            self.deletes.append(item_key)
            for prefix in self.rows:
                self.rows[prefix] = [row for row in self.rows[prefix] if row['key'] != item_key]
            ET.SubElement(ET.SubElement(root, 'Deleted'), 'Key').text = item_key
        return 200, ET.tostring(root), {}


class RemovalSafety(unittest.TestCase):
    def test_changed_last_prefix_aborts_before_any_remote_mutation(self):
        plan = fixture()
        client = Client(plan)
        client.rows[plan['targets'][-1]['prefix']][0]['etag'] = '"changed"'
        with self.assertRaisesRegex(AssertionError, 'Remote objects changed'):
            execute(client, plan)
        self.assertEqual(client.deletes, [])

    def test_versioning_change_aborts_before_any_remote_mutation(self):
        plan = fixture()
        client = Client(plan)
        client.versioning = '<Status>Enabled</Status>'
        with self.assertRaisesRegex(AssertionError, 'versioning changed'):
            execute(client, plan)
        self.assertEqual(client.deletes, [])

    def test_only_exact_reviewed_objects_deleted_and_all_prefixes_verified_empty(self):
        plan = fixture()
        client = Client(plan)
        client.rows['unrelated/'] = [{'key': 'unrelated/customer-data', 'size': 9, 'etag': '"retain"'}]
        result = execute(client, plan)
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['objects_removed'], 38)
        self.assertEqual(client.rows['unrelated/'][0]['key'], 'unrelated/customer-data')
        self.assertEqual(set(client.deletes), {t['objects'][0]['key'] for t in plan['targets']})


if __name__ == '__main__':
    unittest.main()
