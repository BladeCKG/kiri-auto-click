# Kiri Auto Click

This Chrome extension auto-clicks matching download buttons on:

- `thenkiri.com`
- `downloadwella.com`

It can click each stage once per page load:

- `Download Movie`
- `Create Download link`
- `Start Download`

After `Start Download`, the background worker asks a local native helper to watch IDM's `DwnlData` logs. When IDM creates or updates a fresh log whose `owp` line matches the current page URL, the extension closes that tab.

## Setup

1. Load this folder as an unpacked extension in `chrome://extensions`.
2. Copy the extension ID shown by Chrome.
3. Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install_native_host.ps1 -ExtensionId YOUR_EXTENSION_ID
```

4. Reload the extension in `chrome://extensions`.

## Uninstall

To remove the native host registration and local build artifacts, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall_native_host.ps1
```

## How detection works

The native helper watches for new or updated `*.log` files under:

- `%APPDATA%\IDM\DwnlData`

When IDM starts a download, those logs contain lines like:

- `owp https://downloadwella.com/...`
- `Url https://dwbe.../movie.mkv`

The helper treats the download as started for the current tab when the fresh IDM log's `owp` matches that tab's URL.
