import json
import os
import struct
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit, urlunsplit


DEFAULT_TIMEOUT_MS = 90000
SCAN_INTERVAL_SECONDS = 0.75


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        return None
    if len(raw_length) != 4:
        raise RuntimeError("Invalid native message length header")

    message_length = struct.unpack("<I", raw_length)[0]
    message_bytes = sys.stdin.buffer.read(message_length)
    if len(message_bytes) != message_length:
        raise RuntimeError("Native message body was truncated")

    return json.loads(message_bytes.decode("utf-8"))


def write_message(message):
    encoded = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def normalize_url(value):
    if not value:
        return ""

    try:
        parts = urlsplit(value)
    except ValueError:
        return ""

    cleaned = parts._replace(fragment="")
    return urlunsplit(cleaned)


def get_filename_from_url(value):
    normalized = normalize_url(value)
    if not normalized:
        return ""

    path = urlsplit(normalized).path
    if not path:
        return ""

    return unquote(path.rstrip("/").split("/")[-1])


def get_expected_dir_prefix(file_name):
    if not file_name:
        return ""

    return file_name[:20]


def get_idm_root():
    configured = os.environ.get("APPDATA")
    if not configured:
        raise RuntimeError("APPDATA is not available")

    root = Path(configured) / "IDM" / "DwnlData"
    if not root.exists():
        raise RuntimeError(f"IDM DwnlData folder was not found: {root}")

    return root


def snapshot_logs(root):
    snapshot = {}
    for path in root.rglob("*.log"):
        try:
            stat = path.stat()
        except OSError:
            continue

        snapshot[str(path)] = (stat.st_mtime_ns, stat.st_size)

    return snapshot


def parse_log_details(path):
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as handle:
            lines = handle.readlines()
    except OSError:
        return None

    details = {
        "owp": "",
        "url": ""
    }

    for line in lines:
        if line.startswith("owp "):
            details["owp"] = normalize_url(line[4:].strip())
        elif line.startswith("Url "):
            details["url"] = normalize_url(line[4:].strip())

    return details


def matches_request(details, page_url, element_url, expected_file_name, expected_dir_prefix, log_path):
    if not details:
        return False

    log_dir_name = log_path.parent.name
    expected_url = normalize_url(element_url)
    logged_url = normalize_url(details["url"])

    if expected_url and logged_url != expected_url:
        return False

    if expected_file_name:
        logged_file_name = get_filename_from_url(details["url"])
        if logged_file_name != expected_file_name:
            return False

    if expected_dir_prefix and not log_dir_name.startswith(expected_dir_prefix):
        return False

    if page_url and details["owp"] and details["owp"] != page_url:
        return False

    if expected_url:
        return True

    if page_url and details["owp"] == page_url and expected_dir_prefix and log_dir_name.startswith(expected_dir_prefix):
        return True

    return False


def watch_for_download(message):
    root = get_idm_root()
    page_url = normalize_url(message.get("page_url"))
    element_url = normalize_url(message.get("element_url"))
    expected_file_name = message.get("expected_file_name") or get_filename_from_url(element_url)
    expected_dir_prefix = message.get("expected_dir_prefix") or get_expected_dir_prefix(expected_file_name)
    triggered_at = int(message.get("triggered_at") or int(time.time() * 1000))
    timeout_ms = int(message.get("timeout_ms") or DEFAULT_TIMEOUT_MS)
    deadline = time.time() + (timeout_ms / 1000)
    min_mtime_ns = max(0, (triggered_at - 1500) * 1_000_000)
    known_logs = snapshot_logs(root)

    while time.time() < deadline:
        current_logs = snapshot_logs(root)
        for path_text, state in current_logs.items():
            previous_state = known_logs.get(path_text)
            if previous_state == state:
                continue

            known_logs[path_text] = state
            mtime_ns, _size = state
            if mtime_ns < min_mtime_ns:
                continue

            log_path = Path(path_text)
            details = parse_log_details(log_path)
            if matches_request(
                details,
                page_url,
                element_url,
                expected_file_name,
                expected_dir_prefix,
                log_path,
            ):
                return {
                    "started": True,
                    "matched_log": path_text,
                    "matched_dir": log_path.parent.name,
                    "page_url": details["owp"],
                    "download_url": details["url"],
                    "expected_file_name": expected_file_name,
                }

        time.sleep(SCAN_INTERVAL_SECONDS)

    return {
        "started": False,
        "reason": "timeout"
    }


def main():
    try:
        message = read_message()
        if message is None:
            return

        if message.get("type") != "watch_download_start":
            write_message({
                "started": False,
                "reason": "unsupported_message"
            })
            return

        write_message(watch_for_download(message))
    except Exception as error:
        write_message({
            "started": False,
            "reason": "error",
            "message": str(error)
        })


if __name__ == "__main__":
    main()
