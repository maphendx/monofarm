import io
import json
import os
import shutil
import subprocess
import sys
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


AGENT_DIR = Path(__file__).parent


def _source_archive() -> bytes:
    files = json.loads((AGENT_DIR / "source_manifest.json").read_text(encoding="utf-8"))
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in files:
            content = b"" if name == "requirements-core.txt" else (AGENT_DIR / name).read_bytes()
            archive.writestr(name, content)
    return output.getvalue()


def test_flat_source_install_bootstraps_package_tree(tmp_path):
    payload = _source_archive()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/agent/source.zip":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        install_dir = tmp_path / "install"
        config_dir = tmp_path / "home" / ".monofarm-agent"
        install_dir.mkdir()
        config_dir.mkdir(parents=True)
        shutil.copy2(AGENT_DIR / "monofarm_agent.py", install_dir)
        config_dir.joinpath(".env").write_text(
            f"MONOFARM_SERVER=http://127.0.0.1:{server.server_port}\n",
            encoding="utf-8",
        )
        env = {**os.environ, "HOME": str(tmp_path / "home"), "PYTHONPATH": str(install_dir)}

        result = subprocess.run(
            [sys.executable, str(install_dir / "monofarm_agent.py"), "--help"],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

        assert result.returncode == 0, result.stderr
        assert (install_dir / "core" / "runtime.py").is_file()
        assert (install_dir / "transports" / "websocket.py").is_file()
        assert (install_dir / "printers" / "bambu.py").is_file()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
