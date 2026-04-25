(() => {
  const DOMAIN_TARGETS = [
    {
      domains: ["source.net", "subsource.net"],
      labels: ["download english subtitle", "download korean subtitle"],
      watchOnClick: true,
      tokenFromSubtitlePath: true
    },
    {
      domains: ["thenkiri.com", "downloadwella.com"],
      labels: ["download movie", "create download link", "start download"],
      watchOnClick: false,
      tokenFromSubtitlePath: false
    }
  ];
  const WATCH_TIMEOUT_MS = 90000;
  const clickedLabels = new Set();
  let watcherStarted = false;

  function getDomainConfig() {
    const host = window.location.hostname.toLowerCase();

    for (const config of DOMAIN_TARGETS) {
      if (config.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
        return config;
      }
    }

    return null;
  }

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

  function looksLikeOpaqueDownloadToken(value) {
    return typeof value === "string" && /^[a-f0-9]{24,}$/i.test(value);
  }

  function getSubtitleToken() {
    try {
      const parsed = new URL(window.location.href);
      const parts = parsed.pathname.split("/").filter(Boolean);
      const subtitleIndex = parts.indexOf("subtitle");
      if (subtitleIndex === -1 || subtitleIndex + 3 >= parts.length) {
        return null;
      }

      const slug = decodeURIComponent(parts[subtitleIndex + 1]).toLowerCase();
      const language = decodeURIComponent(parts[subtitleIndex + 2]).toLowerCase();
      const subtitleId = decodeURIComponent(parts[subtitleIndex + 3]).toLowerCase();
      return `${slug}_${language}_${subtitleId}`;
    } catch {
      return null;
    }
  }

  function hasConcreteFileName(fileName) {
    return typeof fileName === "string" && /\.[a-z0-9]{2,5}$/i.test(fileName);
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

    const config = getDomainConfig();
    const elementUrl = getElementUrl(target.element);
    const rawFileName = getFileNameFromUrl(elementUrl);
    const subtitleUsesApiToken = config && config.tokenFromSubtitlePath && looksLikeOpaqueDownloadToken(rawFileName);
    const isSubtitleFlow = config && config.tokenFromSubtitlePath;
    const fileName = isSubtitleFlow ? null : rawFileName;
    const expectedDirPrefix = subtitleUsesApiToken
      ? getExpectedDirPrefix(rawFileName)
      : getExpectedDirPrefix(fileName);
    const expectedNameToken = config && config.tokenFromSubtitlePath && !subtitleUsesApiToken
      ? getSubtitleToken()
      : null;

    watcherStarted = true;
    chrome.runtime.sendMessage({
      type: "watch-start-download",
      pageUrl: window.location.href,
      elementUrl,
      expectedFileName: fileName,
      expectedDirPrefix,
      expectedNameToken,
      triggeredAt: Date.now(),
      timeoutMs: WATCH_TIMEOUT_MS
    });
  }

  function clickNextTarget() {
    const config = getDomainConfig();
    if (!config) {
      return false;
    }

    for (const targetLabel of config.labels) {
      if (clickedLabels.has(targetLabel)) {
        continue;
      }

      const target = findTargetForLabel(targetLabel);
      if (!target) {
        continue;
      }

      clickedLabels.add(targetLabel);

      if (config.watchOnClick || targetLabel === "start download") {
        notifyStartDownload(target);
      }

      target.element.click();

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
