(() => {
  const TARGET_LABELS = [
    "download movie",
    "create download link",
    "start download"
  ];
  const WATCH_TIMEOUT_MS = 90000;
  const clickedLabels = new Set();
  let watcherStarted = false;

  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function getElementLabel(element) {
    const parts = [
      element.innerText,
      element.textContent,
      element.getAttribute("value"),
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ];

    return normalizeText(parts.filter(Boolean).join(" "));
  }

  function getElementUrl(element) {
    const urlCandidates = [
      element.getAttribute("href"),
      element.getAttribute("data-href"),
      element.getAttribute("data-url"),
      element.getAttribute("formaction"),
      element.value
    ];

    for (const candidate of urlCandidates) {
      if (!candidate) {
        continue;
      }

      try {
        return new URL(candidate, window.location.href).href;
      } catch {
        // Ignore non-URL values.
      }
    }

    return null;
  }

  function getFileNameFromUrl(url) {
    if (!url) {
      return null;
    }

    try {
      const parsed = new URL(url);
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      const lastPart = pathParts[pathParts.length - 1];
      return lastPart ? decodeURIComponent(lastPart) : null;
    } catch {
      return null;
    }
  }

  function getExpectedDirPrefix(fileName) {
    if (!fileName) {
      return null;
    }

    return fileName.slice(0, 20);
  }

  function isClickable(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (typeof element.click !== "function") {
      return false;
    }

    const tagName = element.tagName.toLowerCase();
    return (
      tagName === "button" ||
      tagName === "a" ||
      tagName === "input" ||
      element.getAttribute("role") === "button" ||
      element.tabIndex >= 0
    );
  }

  function findTargetForLabel(targetLabel) {
    const candidates = document.querySelectorAll(
      "button, a, input[type='button'], input[type='submit'], [role='button']"
    );

    for (const element of candidates) {
      if (!isClickable(element)) {
        continue;
      }

      const label = getElementLabel(element);
      if (label.includes(targetLabel)) {
        return {
          element,
          label,
          targetLabel
        };
      }
    }

    return null;
  }

  function notifyStartDownload(target) {
    if (watcherStarted) {
      return;
    }

    const elementUrl = getElementUrl(target.element);
    const fileName = getFileNameFromUrl(elementUrl);

    watcherStarted = true;
    chrome.runtime.sendMessage({
      type: "watch-start-download",
      pageUrl: window.location.href,
      elementUrl,
      expectedFileName: fileName,
      expectedDirPrefix: getExpectedDirPrefix(fileName),
      triggeredAt: Date.now(),
      timeoutMs: WATCH_TIMEOUT_MS
    });
  }

  function clickNextTarget() {
    for (const targetLabel of TARGET_LABELS) {
      if (clickedLabels.has(targetLabel)) {
        continue;
      }

      const target = findTargetForLabel(targetLabel);
      if (!target) {
        continue;
      }

      clickedLabels.add(targetLabel);
      target.element.click();

      if (targetLabel === "start download") {
        notifyStartDownload(target);
      }

      return true;
    }

    return false;
  }

  function startWatching() {
    clickNextTarget();

    const observer = new MutationObserver(() => {
      clickNextTarget();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["value", "aria-label", "title", "href", "data-href", "data-url"]
    });

    window.setTimeout(() => {
      observer.disconnect();
    }, WATCH_TIMEOUT_MS);
  }

  if (document.readyState === "complete") {
    startWatching();
  } else {
    window.addEventListener("load", startWatching, { once: true });
  }
})();
