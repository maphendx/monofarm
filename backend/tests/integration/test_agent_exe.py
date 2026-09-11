"""GET /agent/monofarm-agent.exe — redirect to the R2-hosted agent binary."""
import io
import json
import re
import zipfile


def test_agent_exe_404_without_object_storage(client, monkeypatch):
    # No S3 bucket → presigned_url_raw returns None → 404. Patched so the test
    # doesn't depend on whether the local .env has S3 configured.
    monkeypatch.setattr(
        "app.services.storage.presigned_url_raw",
        lambda key, expires=3600: None,
    )
    resp = client.get("/agent/monofarm-agent.exe", follow_redirects=False)
    assert resp.status_code == 404


def test_agent_exe_redirects_to_presigned_url(client, monkeypatch):
    # When storage yields a URL, the route 302-redirects to it. This also proves
    # the exe route is matched before the generic /agent/{filename} whitelist.
    monkeypatch.setattr(
        "app.services.storage.presigned_url_raw",
        lambda key, expires=3600: "https://r2.example/agent/monofarm-agent.exe?sig=x",
    )
    resp = client.get("/agent/monofarm-agent.exe", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"].startswith("https://r2.example/")


def test_agent_source_archive_is_complete_and_version_consistent(client):
    resp = client.get("/agent/source.zip")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(resp.content)) as archive:
        manifest = json.loads(archive.read("source_manifest.json"))
        assert set(archive.namelist()) == set(manifest)
        assert {
            "monofarm_agent.py",
            "core/runtime.py",
            "transports/websocket.py",
            "printers/bambu.py",
            "printers/moonraker.py",
        }.issubset(manifest)
        versions = {
            re.search(
                rb'^AGENT_VERSION\s*=\s*"([^"]+)"',
                archive.read(filename),
                re.MULTILINE,
            ).group(1)
            for filename in ("monofarm_agent.py", "monofarm_tray.py")
        }

    from app.api.agent import AGENT_VERSION

    assert versions == {AGENT_VERSION.encode()}
