import copy
import unittest
from remove_retired_rc_s3_storage import execute,RETIRED
from test_remove_s3_test_storage import Client

def fixture():
    return {'status':'PLAN-ONLY-AWAITING-EXPLICIT-REMOTE-DATA-DELETION-APPROVAL','versioning':'Disabled',
      'total_entries':8272,'total_bytes':8272*7,'targets':[{'prefix':RETIRED,'objects':[
        {'key':RETIRED+'object-'+str(i),'size':7,'etag':'"owned"','version_id':None,'delete_marker':False} for i in range(8272)]}]}

class RetiredRCSafety(unittest.TestCase):
    def test_active_prefix_cannot_be_retired(self):
        p=fixture();c=Client(p)
        with self.assertRaises(AssertionError):execute(c,p,RETIRED)
        self.assertEqual(c.deletes,[])
    def test_changed_remote_tail_prevents_all_deletions(self):
        p=fixture();c=Client(p);c.rows[RETIRED][-1]['etag']='"changed"'
        with self.assertRaisesRegex(AssertionError,'Remote objects changed'):execute(c,p,'active/')
        self.assertEqual(c.deletes,[])
    def test_dry_run_and_exact_deletion_preserve_other_prefixes(self):
        p=fixture();c=Client(p);c.rows['unrelated/']=[{'key':'unrelated/customer-data','size':9,'etag':'"retain"'}]
        self.assertEqual(execute(c,p,'active/',True)['status'],'PRECONDITIONS-PASS');self.assertEqual(c.deletes,[])
        r=execute(c,p,'active/');self.assertEqual(r['objects_removed'],8272)
        self.assertEqual(c.rows['unrelated/'][0]['key'],'unrelated/customer-data')

if __name__=='__main__':unittest.main()
