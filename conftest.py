import os
import sys
import tempfile
from pathlib import Path

# Isolate runtime data and make the app package importable
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="mediagrab-test-"))
os.environ.setdefault("SECRET_KEY", "test-secret")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
