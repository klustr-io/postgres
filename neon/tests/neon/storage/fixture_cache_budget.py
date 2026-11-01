"""Explicit cache/free-space budget for the isolated qualification filesystem."""
import hashlib
from pathlib import Path
import re
import tomllib
from pageserver_cache import wait_for_stopped_replay

POLICY={'max_usage_pct':90,'min_avail_bytes':12*1024**3,'period':'10s'}

def wait_fixture_storage_ready(timeout=180,spec_path=Path('/var/lib/neon/comparison/neon/endpoints/bench/config.json')):
    return wait_for_stopped_replay(timeout=timeout,spec_path=spec_path)

def configure_fixture_cache_budget(stamp,root=Path('/var/lib/neon/comparison/neon/pageserver_1')):
    assert re.fullmatch(r'[0-9]{17}',stamp)
    path=root/'pageserver.toml';assert not path.is_symlink()
    original=path.read_bytes();text=original.decode();config=tomllib.loads(text)
    prior=config.get('disk_usage_based_eviction')
    if prior==POLICY:
        return {'status':'PASS','changed':False,'policy':POLICY,'prior_explicit_policy':prior,
                'scope':'Isolated fixture cache budget; eviction stays enabled; separate 8GiB hard-stop guard unchanged'}
    # Fail closed on an unfamiliar explicit policy instead of discarding it.
    assert prior is None,'Review existing explicit disk-eviction policy before replacement'
    backup=root/('pageserver-before-cache-budget-'+stamp+'.private');assert not backup.exists();backup.write_bytes(original)
    replacement='disk_usage_based_eviction = { max_usage_pct = 90, min_avail_bytes = 12884901888, period = "10s" }\n'+text
    parsed=tomllib.loads(replacement);assert parsed.pop('disk_usage_based_eviction')==POLICY and parsed==config
    temporary=root/('pageserver-cache-budget-'+stamp+'.private');assert not temporary.exists()
    temporary.write_text(replacement);temporary.replace(path)
    return {'status':'PASS','changed':True,'policy':POLICY,'prior_explicit_policy':prior,
            'original_private_config_sha256':hashlib.sha256(original).hexdigest(),
            'scope':'Isolated fixture cache budget; eviction stays enabled; separate 8GiB hard-stop guard unchanged'}
