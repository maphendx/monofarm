"""Public agent distribution routes."""

from pathlib import Path

import pytest

from app.api import agent as agent_api


_SOURCE_RUNTIME_FILES = (
    "monofarm_agent.py",
    "monofarm_tray.py",
    "command_runtime.py",
    "command_worker.py",
    "device_identity.py",
    "network_policy.py",
    "printer_runtime.py",
    "provider_adapters.py",
    "update_policy.py",
    "requirements.txt",
    "edge_runtime/__init__.py",
    "edge_runtime/adapters.py",
    "edge_runtime/artifact_spool.py",
    "edge_runtime/journal.py",
    "edge_runtime/registry.py",
    "edge_runtime/transfer.py",
)


def test_signed_manifest_uses_the_exact_distributed_runtime_set():
    assert agent_api._AGENT_SOURCE_FILES == set(_SOURCE_RUNTIME_FILES)


def test_agent_exe_404_without_object_storage(client, monkeypatch):
    monkeypatch.setattr(
        "app.api.agent.agent_windows_download_url",
        lambda: None,
    )
    resp = client.get("/agent/monofarm-agent.exe", follow_redirects=False)
    assert resp.status_code == 404


def test_agent_exe_redirects_to_presigned_url(client, monkeypatch):
    monkeypatch.setattr(
        "app.api.agent.agent_windows_download_url",
        lambda: "https://r2.example/agent/releases/0.9.0/monofarm-agent.exe?sig=x",
    )
    resp = client.get("/agent/monofarm-agent.exe", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"].startswith("https://r2.example/")


def test_versioned_release_routes_delegate_only_to_verified_manifest(client, monkeypatch):
    monkeypatch.setattr(
        "app.api.agent.agent_release_download_url",
        lambda version, artifact: (
            f"https://r2.example/agent/releases/{version}/{artifact}?sig=x"
            if version == agent_api.AGENT_VERSION
            else None
        ),
    )

    windows = client.get(
        f"/agent/releases/{agent_api.AGENT_VERSION}/monofarm-agent.exe",
        follow_redirects=False,
    )
    source = client.get(
        f"/agent/releases/{agent_api.AGENT_VERSION}/runtime/edge_runtime/journal.py",
        follow_redirects=False,
    )
    old = client.get(
        "/agent/releases/0.8.10/monofarm-agent.exe",
        follow_redirects=False,
    )

    assert windows.status_code == 302
    assert source.status_code == 302
    assert old.status_code == 404


def test_windows_release_workflow_uses_ci_attestation_and_immutable_key() -> None:
    workflow = (
        Path(__file__).resolve().parents[3] / ".github" / "workflows" / "agent-build.yml"
    ).read_text(encoding="utf-8")

    assert "AGENT_RELEASE_ATTESTATION_PRIVATE_KEY" in workflow
    assert "agent/releases/${VERSION}/monofarm-agent.exe" in workflow
    assert '"schema_version": 1' in workflow
    assert '"algorithm": "Ed25519"' in workflow
    assert '"platform": "windows-x86_64"' in workflow
    assert "sort_keys=True" in workflow
    assert 'separators=(",", ":")' in workflow
    assert "group: agent-windows-release" in workflow
    assert 'MANIFEST_KEY="agent/releases/${VERSION}/manifest.json"' in workflow
    assert '"schema_version": 2' in workflow
    assert '"expires_at": "9999-12-31T23:59:59+00:00"' in workflow
    assert workflow.index('"s3://${R2_BUCKET}/${source_key}"') < workflow.index(
        '"s3://${R2_BUCKET}/${MANIFEST_KEY}"'
    )
    assert 's3://${R2_BUCKET}/agent/monofarm-agent.exe' not in workflow


@pytest.mark.parametrize("filename", _SOURCE_RUNTIME_FILES)
def test_source_runtime_files_are_explicitly_served(client, filename):
    response = client.get(f"/agent/runtime/{filename}")

    assert response.status_code == 200


def test_legacy_agent_source_route_serves_bootstrap_not_modular_runtime(client):
    legacy = client.get("/agent/monofarm_agent.py")
    runtime = client.get("/agent/runtime/monofarm_agent.py")

    assert legacy.status_code == 200
    assert runtime.status_code == 200
    assert b"legacy bootstrap" in legacy.content.lower()
    assert legacy.content != runtime.content


@pytest.mark.parametrize(
    "filename",
    (
        ".env",
        "monofarm-agent.spec",
        "edge_runtime/not_a_runtime_module.py",
        "edge_runtime/../test_update_policy.py",
    ),
)
def test_source_route_rejects_files_outside_the_explicit_allowlist(
    client,
    filename,
):
    response = client.get(f"/agent/runtime/{filename}")

    assert response.status_code == 404


def test_old_nested_source_route_does_not_bypass_runtime_prefix(client):
    response = client.get("/agent/edge_runtime/transfer.py")

    assert response.status_code == 404
