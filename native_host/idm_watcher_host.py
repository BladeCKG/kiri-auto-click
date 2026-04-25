import json
import os
import struct
import sys
import time
import winreg
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


def normalize_token(value):
    return (value or "").strip().lower()


def read_download_manager_value(name):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\DownloadManager") as key:
            value, _value_type = winreg.QueryValueEx(key, name)
            return value
    except OSError:
        return ""


def get_idm_temp_root():
    configured = read_download_manager_value("TempPath")
    if configured:
        return Path(configured)

    temp_dir = os.environ.get("TEMP") or os.environ.get("TMP")
    if not temp_dir:
        raise RuntimeError("IDM TempPath and TEMP/TMP are unavailable")

    return Path(temp_dir)


def get_idm_candidate_roots():
    roots = []
    user_name = os.environ.get("USERNAME", "").strip()

    def add_candidate(base_root):
        if not base_root.exists():
            return

        user_root = base_root / user_name if user_name else None
        if user_root and user_root.exists():
            if user_root not in roots:
                roots.append(user_root)
            return

        if base_root not in roots:
            roots.append(base_root)

    temp_root = get_idm_temp_root()
    temp_dwnldata = temp_root / "DwnlData"
    add_candidate(temp_dwnldata)

    configured = read_download_manager_value("AppDataIDMFolder")
    if configured:
        configured_root = Path(configured) / "DwnlData"
        add_candidate(configured_root)

    configured = os.environ.get("APPDATA")
    if configured:
        fallback_root = Path(configured) / "IDM" / "DwnlData"
        add_candidate(fallback_root)

    if not roots:
        raise RuntimeError("IDM DwnlData folder was not found in temp path or app data")

    return roots


def get_idm_root():
    return get_idm_candidate_roots()[0]


def snapshot_logs(root):
    snapshot = {}
    for path in root.rglob("*.log"):
        try:
            stat = path.stat()
        except OSError:
            continue

        snapshot[str(path)] = (stat.st_mtime_ns, stat.st_size)

    return snapshot


def snapshot_dirs(root):
    snapshot = {}
    try:
        for path in root.iterdir():
            if not path.is_dir():
                continue

            try:
                stat = path.stat()
            except OSError:
                continue

            snapshot[str(path)] = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        return snapshot

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


def matches_request(
    details,
    page_url,
    element_url,
    expected_file_name,
    expected_dir_prefix,
    expected_name_token,
    log_path,
):
    if not details:
        return False

    log_dir_name = log_path.parent.name
    expected_url = normalize_url(element_url)
    logged_url = normalize_url(details["url"])
    logged_file_name = get_filename_from_url(details["url"])
    expected_name_token = normalize_token(expected_name_token)
    exact_url_match = bool(expected_url and logged_url == expected_url)

    if expected_file_name:
        if logged_file_name != expected_file_name:
            return False

    if expected_dir_prefix and not log_dir_name.startswith(expected_dir_prefix):
        return False

    if expected_name_token:
        token_matches = (
            expected_name_token in logged_file_name.lower()
            or expected_name_token in log_dir_name.lower()
            or expected_name_token in details["owp"].lower()
        )
        if not token_matches:
            return False

    if page_url and details["owp"] and details["owp"] != page_url:
        return False

    if exact_url_match:
        return True

    if page_url and details["owp"] == page_url:
        if expected_dir_prefix and log_dir_name.startswith(expected_dir_prefix):
            return True
        if expected_name_token:
            return True

    return False


def matches_dir_request(dir_path, expected_dir_prefix, expected_name_token):
    dir_name = dir_path.name.lower()
    expected_dir_prefix = (expected_dir_prefix or "").lower()
    expected_name_token = normalize_token(expected_name_token)

    if expected_dir_prefix and dir_name.startswith(expected_dir_prefix):
        return True

    if expected_name_token and expected_name_token in dir_name:
        return True

    return False


def watch_for_download(message):
    roots = get_idm_candidate_roots()
    page_url = normalize_url(message.get("page_url"))
    element_url = normalize_url(message.get("element_url"))
    expected_file_name = message.get("expected_file_name") or get_filename_from_url(element_url)
    expected_dir_prefix = message.get("expected_dir_prefix") or get_expected_dir_prefix(expected_file_name)
    expected_name_token = normalize_token(message.get("expected_name_token"))
    triggered_at = int(message.get("triggered_at") or int(time.time() * 1000))
    timeout_ms = int(message.get("timeout_ms") or DEFAULT_TIMEOUT_MS)
    deadline = time.time() + (timeout_ms / 1000)
    min_mtime_ns = max(0, (triggered_at - 1500) * 1_000_000)
    known_logs = {}
    known_dirs = {}
    for root in roots:
        known_logs.update(snapshot_logs(root))
        known_dirs.update(snapshot_dirs(root))

    while time.time() < deadline:
        current_logs = {}
        current_dirs = {}
        for root in roots:
            current_logs.update(snapshot_logs(root))
            current_dirs.update(snapshot_dirs(root))

        for path_text, state in current_dirs.items():
            previous_state = known_dirs.get(path_text)
            if previous_state == state:
                continue

            known_dirs[path_text] = state
            mtime_ns, _size = state
            if mtime_ns < min_mtime_ns:
                continue

            dir_path = Path(path_text)
            if matches_dir_request(dir_path, expected_dir_prefix, expected_name_token):
                return {
                    "started": True,
                    "matched_dir": dir_path.name,
                    "matched_by": "directory",
                    "expected_file_name": expected_file_name,
                    "expected_name_token": expected_name_token,
                }

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
                expected_name_token,
                log_path,
            ):
                return {
                    "started": True,
                    "matched_log": path_text,
                    "matched_dir": log_path.parent.name,
                    "page_url": details["owp"],
                    "download_url": details["url"],
                    "expected_file_name": expected_file_name,
                    "expected_name_token": expected_name_token,
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
