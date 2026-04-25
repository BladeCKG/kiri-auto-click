(() => {
  const CLICK_MARK_ATTR = "data-kiri-auto-clicked";
  const DOMAIN_TARGETS = [
    {
      domains: ["subsource.net"],
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
  const clickedSubsourceLinks = new Set();
  const openedSubsourceUrls = new Set();
  let subsourceEnglishOpened = false;
  let watcherStarted = false;
  let observerStarted = false;
  let routeWatcherStarted = false;
  let currentRouteKey = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  let subsourceScrollPromise = null;

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

  function isSubsourceHost() {
    const host = window.location.hostname.toLowerCase();
    return host === "subsource.net" || host.endsWith(".subsource.net");
  }

  function isSubtitleDetailPage() {
    try {
      const parsed = new URL(window.location.href);
      return parsed.pathname.split("/").filter(Boolean).includes("subtitle");
    } catch {
      return false;
    }
  }

  function isSubtitlesListingPage() {
    try {
      const parsed = new URL(window.location.href);
      return parsed.pathname.toLowerCase().startsWith("/subtitles/");
    } catch {
      return false;
    }
  }

  function getCurrentSubtitlesSlug() {
    try {
      const parsed = new URL(window.location.href);
      const parts = parsed.pathname.split("/").filter(Boolean);
      const subtitlesIndex = parts.indexOf("subtitles");
      if (subtitlesIndex === -1 || subtitlesIndex + 1 >= parts.length) {
        return null;
      }

      return decodeURIComponent(parts[subtitlesIndex + 1]).toLowerCase();
    } catch {
      return null;
    }
  }

  function getCurrentSubtitlesSlugCandidates() {
    const currentSlug = getCurrentSubtitlesSlug();
    if (!currentSlug) {
      return [];
    }

    const candidates = new Set([currentSlug]);
    const trimmedSuffix = currentSlug.replace(/-\d+$/, "");
    if (trimmedSuffix) {
      candidates.add(trimmedSuffix);
    }

    return Array.from(candidates);
  }

  function hrefMatchesCurrentSubsourceRoute(href) {
    const candidates = getCurrentSubtitlesSlugCandidates();
    if (candidates.length === 0) {
      return true;
    }

    try {
      const parsed = new URL(href);
      const path = parsed.pathname.toLowerCase();
      return candidates.some((candidate) => {
        return path.includes(`/subtitle/${candidate}/`) || path.includes(`/subtitles/${candidate}`);
      });
    } catch {
      return false;
    }
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

  function openUrlInNewTab(url) {
    if (!url) {
      return;
    }

    if (openedSubsourceUrls.has(url)) {
      return;
    }

    openedSubsourceUrls.add(url);
    chrome.runtime.sendMessage({
      type: "open-new-tab",
      url
    });
  }

  function resetPageState() {
    clickedLabels.clear();
    clickedSubsourceLinks.clear();
    openedSubsourceUrls.clear();
    subsourceEnglishOpened = false;
    watcherStarted = false;
    subsourceScrollPromise = null;
    document.querySelectorAll(`[${CLICK_MARK_ATTR}="1"]`).forEach((element) => {
      element.removeAttribute(CLICK_MARK_ATTR);
    });
  }

  function handleRouteChange() {
    const nextRouteKey = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextRouteKey === currentRouteKey) {
      return;
    }

    currentRouteKey = nextRouteKey;
    resetPageState();
    window.requestAnimationFrame(() => {
      clickNextTarget();
    });
  }

  function startRouteWatcher() {
    if (routeWatcherStarted || !isSubsourceHost()) {
      return;
    }

    routeWatcherStarted = true;

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      handleRouteChange();
      return result;
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      handleRouteChange();
      return result;
    };

    window.addEventListener("popstate", handleRouteChange);
    window.setInterval(handleRouteChange, 500);
  }

  async function scrollSubsourceListingToBottom() {
    if (!isSubsourceHost() || !isSubtitlesListingPage()) {
      return;
    }

    let stablePasses = 0;
    let previousHeight = -1;

    while (stablePasses < 4) {
      const currentHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );
      const maxScrollableY = Math.max(0, currentHeight - window.innerHeight);
      const alreadyAtBottom = window.scrollY >= maxScrollableY;

      window.scrollTo({
        top: currentHeight,
        behavior: "auto"
      });

      await new Promise((resolve) => {
        window.setTimeout(resolve, 400);
      });

      const nextHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );

      const nextMaxScrollableY = Math.max(0, nextHeight - window.innerHeight);
      const atBottom = window.scrollY >= nextMaxScrollableY || Math.ceil(window.innerHeight + window.scrollY) >= nextHeight;
      const noAdditionalGrowth = nextHeight <= currentHeight;

      if ((alreadyAtBottom && noAdditionalGrowth) || (nextHeight === previousHeight && atBottom)) {
        stablePasses += 1;
      } else {
        stablePasses = 0;
      }

      previousHeight = nextHeight;
    }
  }

  function startSubsourceListingFlow() {
    if (!isSubsourceHost() || !isSubtitlesListingPage()) {
      return false;
    }

    if (!subsourceScrollPromise) {
      const routeKeyAtStart = currentRouteKey;
      subsourceScrollPromise = scrollSubsourceListingToBottom()
        .then(() => {
          if (routeKeyAtStart !== currentRouteKey) {
            return false;
          }
          return clickSubsourceTableLinksFromListing();
        })
        .finally(() => {
          subsourceScrollPromise = null;
        });
    }

    return !!subsourceScrollPromise;
  }

  function clickSubsourceTableLinksFromListing() {
    if (!isSubsourceHost() || !isSubtitlesListingPage()) {
      return false;
    }

    const rows = document.querySelectorAll("table tr, tbody tr, tr");
    let clickedAny = false;

    for (const row of rows) {
      if (!(row instanceof HTMLTableRowElement)) {
        continue;
      }

      const cells = row.querySelectorAll("td");
      const secondCell = cells.length >= 2 ? cells[1] : null;
      if (!(secondCell instanceof HTMLTableCellElement)) {
        continue;
      }

      const cellLabel = normalizeText(secondCell.innerText || secondCell.textContent);
      const wantsEnglish = cellLabel.includes("english");
      const wantsKorean = cellLabel.includes("korean");
      if (!wantsEnglish && !wantsKorean) {
        continue;
      }

      const links = secondCell.querySelectorAll("a");
      for (const link of links) {
        if (!(link instanceof HTMLElement) || !isClickable(link)) {
          continue;
        }

        const href = getElementUrl(link);
        if (!href) {
          continue;
        }

        if (!hrefMatchesCurrentSubsourceRoute(href)) {
          continue;
        }

        const label = wantsKorean ? "korean" : "english";
        const key = `${label}|${href}`;

        if (link.getAttribute(CLICK_MARK_ATTR) === "1" || clickedSubsourceLinks.has(key)) {
          continue;
        }

        if (label === "korean") {
          clickedSubsourceLinks.add(key);
          link.setAttribute(CLICK_MARK_ATTR, "1");
          openUrlInNewTab(href);
          clickedAny = true;
          break;
        }

        if (label === "english" && !subsourceEnglishOpened) {
          clickedSubsourceLinks.add(key);
          link.setAttribute(CLICK_MARK_ATTR, "1");
          openUrlInNewTab(href);
          clickedAny = true;
          subsourceEnglishOpened = true;
          break;
        }
      }
    }

    return clickedAny;
  }

  function clickNextTarget() {
    if (isSubsourceHost() && isSubtitlesListingPage()) {
      const clickedFromListing = clickSubsourceTableLinksFromListing();
      startSubsourceListingFlow();
      if (clickedFromListing) {
        return true;
      }
    }

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
    if (observerStarted) {
      clickNextTarget();
      return;
    }

    observerStarted = true;
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

    if (!isSubsourceHost()) {
      window.setTimeout(() => {
        observer.disconnect();
      }, WATCH_TIMEOUT_MS);
    }
  }

  startRouteWatcher();
  window.addEventListener("pageshow", () => {
    clickNextTarget();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      handleRouteChange();
      clickNextTarget();
    }
  });
  if (document.readyState === "complete" || document.readyState === "interactive") {
    startWatching();
  } else {
    window.addEventListener("load", startWatching, { once: true });
  }
})();
