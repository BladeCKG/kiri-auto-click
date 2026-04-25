const HOST_NAME = "com.kiri.idm_watcher";
const pendingTabs = new Map();

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

  if (message && message.type === "open-new-tab" && typeof message.url === "string") {
    chrome.tabs.create({ url: message.url, active: false })
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        console.error("Open new tab failed", error);
        sendResponse({ ok: false });
      });
    return true;
  }

  if (!tabId || !message || message.type !== "watch-start-download") {
    return;
  }

  if (pendingTabs.has(tabId)) {
    sendResponse({ ok: true, pending: true });
    return true;
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
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingTabs.delete(tabId);
});
