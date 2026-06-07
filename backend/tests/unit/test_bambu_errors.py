from app.services.bambu_errors import BambuErrorCode, error_details, is_retryable, to_technical_message, to_user_message


def test_bambu_error_taxonomy_messages_and_retryability():
    assert is_retryable(BambuErrorCode.OSS_UPLOAD_FAILED)
    assert is_retryable("TASK_CREATE_FAILED")
    assert not is_retryable(BambuErrorCode.INVALID_3MF)
    assert not is_retryable("UNKNOWN_CODE")

    assert "not a valid" in to_user_message(BambuErrorCode.INVALID_3MF)
    assert "acknowledge" in to_user_message(BambuErrorCode.MQTT_ACK_TIMEOUT)
    assert "task creation" in to_technical_message(BambuErrorCode.TASK_CREATE_FAILED)


def test_bambu_error_details_include_code_and_retryable_default():
    details = error_details(BambuErrorCode.PROJECT_CREATE_FAILED, stage="project")

    assert details["error_code"] == "PROJECT_CREATE_FAILED"
    assert details["retryable"] is True
    assert details["stage"] == "project"
