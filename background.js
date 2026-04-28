const HOST_NAME = "com.kiri.idm_watcher";
const pendingTabs = new Map();
const ENABLED_KEY = "extensionEnabled";

async function getEnabled() {
  const result = await chrome.storage.local.get(ENABLED_KEY);
  return result[ENABLED_KEY] !== false;
}

async function setEnabled(enabled) {
  await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
  await updateActionUi(enabled);
}

async function updateActionUi(enabled) {
  await chrome.action.setBadgeText({ text: enabled ? "ON" : "OFF" });
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? "#1f8b4c" : "#666666" });
  await chrome.action.setTitle({
    title: enabled ? "Kiri Auto Click: Enabled" : "Kiri Auto Click: Disabled"
  });
}

function closeTab(tabId) {
  return chrome.tabs.remove(tabId).catch(() => {
    // Ignore tabs that are already gone.
  });
}

async function watchIdmStart(tabId, payload) {
  const response = await chrome.runtime.sendNativeMessage(HOST_NAME, {
    type: "watch_download_start",
    page_url: payload.pageUrl,
    element_url: payload.elementUrl,
    expected_file_name: payload.expectedFileName,
    expected_dir_prefix: payload.expectedDirPrefix,
    expected_name_token: payload.expectedNameToken,
    allow_directory_match: !!payload.allowDirectoryMatch,
    triggered_at: payload.triggeredAt,
    timeout_ms: payload.timeoutMs
  });

  if (!response || !response.started) {
    return;
  }

  await closeTab(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (message && message.type === "get-extension-enabled") {
    getEnabled()
      .then((enabled) => sendResponse({ enabled }))
      .catch(() => sendResponse({ enabled: true }));
    return true;
  }

  if (message && message.type === "open-new-tab" && typeof message.url === "string") {
    getEnabled()
      .then((enabled) => {
        if (!enabled) {
          sendResponse({ ok: false, disabled: true });
          return;
        }

        chrome.tabs.create({ url: message.url, active: false })
          .then(() => {
            sendResponse({ ok: true });
          })
          .catch((error) => {
            console.error("Open new tab failed", error);
            sendResponse({ ok: false });
          });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (!tabId || !message || message.type !== "watch-start-download") {
    return;
  }

  getEnabled()
    .then((enabled) => {
      if (!enabled) {
        sendResponse({ ok: false, disabled: true });
        return;
      }

      if (pendingTabs.has(tabId)) {
        sendResponse({ ok: true, pending: true });
        return;
      }

      pendingTabs.set(tabId, true);

      watchIdmStart(tabId, message)
        .catch((error) => {
          console.error("IDM watch failed", error);
        })
        .finally(() => {
          pendingTabs.delete(tabId);
        });

      sendResponse({ ok: true, pending: false });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingTabs.delete(tabId);
});

chrome.runtime.onInstalled.addListener(async () => {
  const enabled = await getEnabled();
  await updateActionUi(enabled);
});

chrome.runtime.onStartup.addListener(async () => {
  const enabled = await getEnabled();
  await updateActionUi(enabled);
});

chrome.action.onClicked.addListener(async () => {
  const nextEnabled = !(await getEnabled());
  await setEnabled(nextEnabled);
  return true;
});
