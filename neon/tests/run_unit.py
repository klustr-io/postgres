"""Discover fast Neon unit checks; no databases, credentials or cluster required."""
import os
from pathlib import Path
import sys
import unittest

root=Path(__file__).resolve().parent/'neon'
helpers=[str(root/category) for category in ('support','storage','compute','services','performance','postgres','security')]
sys.path[:0]=helpers
os.environ['PYTHONPATH']=os.pathsep.join(helpers+[os.environ['PYTHONPATH']] if os.environ.get('PYTHONPATH') else helpers)
suite=unittest.defaultTestLoader.discover(str(root/'unit'),pattern='test_*.py')
result=unittest.TextTestRunner(verbosity=1).run(suite)
sys.exit(0 if result.wasSuccessful() else 1)
