"""Unit tests for bambu_dispatch.fetch_project_profile (profileId/cover for /my/task)."""
from unittest.mock import MagicMock, patch

from app.services import bambu_dispatch


def _resp(json_data):
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = json_data
    return resp


_PROJECT_DETAIL = {
    "project_id": "proj_1",
    "profiles": [
        {
            "profile_id": "42",
            "context": {
                "plates": [
                    {
                        "index": 2,
                        "thumbnail": {"url": "https://model-file.bambulab.com/plate_2.png"},
                    }
                ]
            },
        }
    ],
}


@patch("app.services.bambu_dispatch._region_api_base", return_value="https://api.test")
@patch("app.services.bambu_auth._load_org", return_value=MagicMock(bambu_region="us"))
def test_extracts_profile_cover_and_plate(_org, _base):
    with patch.object(bambu_dispatch, "_execute_with_retry", return_value=_resp(_PROJECT_DETAIL)):
        info = bambu_dispatch.fetch_project_profile(1, "proj_1")
    assert info == {
        "profile_id": 42,
        "cover": "https://model-file.bambulab.com/plate_2.png",
        "plate_index": 2,
    }


@patch("app.services.bambu_dispatch._PROFILE_POLL_DELAY_SECONDS", 0)
@patch("app.services.bambu_dispatch._region_api_base", return_value="https://api.test")
@patch("app.services.bambu_auth._load_org", return_value=MagicMock(bambu_region="us"))
def test_defaults_when_profile_never_appears(_org, _base):
    with patch.object(bambu_dispatch, "_execute_with_retry", return_value=_resp({"profiles": []})):
        info = bambu_dispatch.fetch_project_profile(1, "proj_1")
    assert info == {"profile_id": None, "cover": "", "plate_index": 1}


@patch("app.services.bambu_dispatch._PROFILE_POLL_DELAY_SECONDS", 0)
@patch("app.services.bambu_dispatch._region_api_base", return_value="https://api.test")
@patch("app.services.bambu_auth._load_org", return_value=MagicMock(bambu_region="us"))
def test_polls_until_profile_attached(_org, _base):
    responses = [_resp({"profiles": []}), _resp({"profiles": []}), _resp(_PROJECT_DETAIL)]
    with patch.object(bambu_dispatch, "_execute_with_retry", side_effect=responses):
        info = bambu_dispatch.fetch_project_profile(1, "proj_1")
    assert info["profile_id"] == 42
    assert isinstance(info["profile_id"], int)


@patch("app.services.bambu_dispatch._PROFILE_POLL_DELAY_SECONDS", 0)
@patch("app.services.bambu_dispatch._region_api_base", return_value="https://api.test")
@patch("app.services.bambu_auth._load_org", return_value=MagicMock(bambu_region="us"))
def test_ignores_non_numeric_profile_id(_org, _base):
    detail = {"profiles": [{"profile_id": "profile-42", "context": {"plates": []}}]}
    with patch.object(bambu_dispatch, "_execute_with_retry", return_value=_resp(detail)):
        info = bambu_dispatch.fetch_project_profile(1, "proj_1")
    assert info == {"profile_id": None, "cover": "", "plate_index": 1}
