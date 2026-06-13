"""GET /agent/monofarm-agent.exe — redirect to the R2-hosted agent binary."""


def test_agent_exe_404_without_object_storage(client):
    # Test env has no S3 bucket → presigned_url_raw returns None → 404.
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
