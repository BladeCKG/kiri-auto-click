(async () => {
  const CLICK_MARK_ATTR = "data-kiri-auto-clicked";
  const CONFIG_URL = chrome.runtime.getURL("sites.json");
  const WATCH_TIMEOUT_MS = 90000;

  let config = null;
  let observerStarted = false;
  let routeWatcherStarted = false;
  let currentRouteKey = getRouteKey();
  let state = createRouteState();

  function createRouteState() {
    return {
      movieClickedLabels: new Set(),
      subtitleClickedKeys: new Set(),
      openedSubtitleUrls: new Set(),
      subtitleEnglishOpened: false,
      watcherStarted: false,
      listingScrollTask: null,
      listingScrollCompleted: false,
      listingSawCandidates: false,
      stopListingScroll: false,
      listingScrolledBackToTop: false
    };
  }

  function resetRouteState() {
    state = createRouteState();
    document.querySelectorAll(`[${CLICK_MARK_ATTR}="1"]`).forEach((element) => {
      element.removeAttribute(CLICK_MARK_ATTR);
    });
  }

  function getRouteKey() {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
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
        // Ignore invalid URLs.
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

  function stripHtmlExtension(fileName) {
    return fileName ? fileName.replace(/\.html?$/i, "") : null;
  }

  function getExpectedDirPrefix(value) {
    return value ? value.slice(0, 20) : null;
  }

  function getLanguageFromText(value) {
    const label = normalizeText(value);
    if (label.includes("korean")) {
      return "korean";
    }
    if (label.includes("english")) {
      return "english";
    }
    return "";
  }

  function looksLikeOpaqueDownloadToken(value) {
    return typeof value === "string" && /^[a-f0-9]{24,}$/i.test(value);
  }

  function getCurrentMovieSite() {
    if (!config) {
      return null;
    }

    const host = window.location.hostname.toLowerCase();
    return config.movieSites.find((site) =>
      site.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
    ) || null;
  }

  function getCurrentSubtitleSite() {
    if (!config) {
      return null;
    }

    const host = window.location.hostname.toLowerCase();
    return config.subtitleSites.find((site) =>
      site.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
    ) || null;
  }

  function currentPathStartsWith(prefixes) {
    try {
      const path = new URL(window.location.href).pathname.toLowerCase();
      return prefixes.some((prefix) => path.startsWith(prefix));
    } catch {
      return false;
    }
  }

  function isSubtitleListingPage() {
    const site = getCurrentSubtitleSite();
    return !!site && currentPathStartsWith(site.listingPrefixes);
  }

  function isSubtitleDetailPage() {
    const site = getCurrentSubtitleSite();
    return !!site && currentPathStartsWith(site.detailPrefixes);
  }

  function getCurrentListingSlugCandidates(site) {
    if (!site) {
      return [];
    }

    try {
      const parts = new URL(window.location.href).pathname.split("/").filter(Boolean);
      for (const prefix of site.listingPrefixes) {
        const prefixParts = prefix.split("/").filter(Boolean);
        const head = prefixParts[0];
        const index = parts.indexOf(head);
        if (index !== -1 && index + 1 < parts.length) {
          const slug = decodeURIComponent(parts[index + 1]).toLowerCase();
          const trimmed = slug.replace(/-\d+$/, "");
          return Array.from(new Set([slug, trimmed].filter(Boolean)));
        }
      }
    } catch {
      return [];
    }

    return [];
  }

  function getSubtitleDetailParts(site) {
    if (!site) {
      return null;
    }

    try {
      const parts = new URL(window.location.href).pathname.split("/").filter(Boolean);
      const detailHead = site.detailPrefixes[0].split("/").filter(Boolean)[0];
      const detailIndex = parts.indexOf(detailHead);
      if (detailIndex === -1) {
        return null;
      }

      return {
        parts,
        detailIndex
      };
    } catch {
      return null;
    }
  }

  function getSubtitleRouteSlug(site) {
    const detail = getSubtitleDetailParts(site);
    if (!detail) {
      return null;
    }

    const slug = detail.parts[detail.detailIndex + 1];
    return slug ? decodeURIComponent(slug).toLowerCase() : null;
  }

  function hrefMatchesCurrentListingRoute(site, href) {
    if (!site || !site.useRouteHrefFilter) {
      return true;
    }

    const candidates = getCurrentListingSlugCandidates(site);
    if (candidates.length === 0) {
      return true;
    }

    try {
      const path = new URL(href).pathname.toLowerCase();
      return candidates.some((candidate) => {
        return path.includes(`/subtitle/${candidate}/`) || path.includes(`/subtitles/${candidate}`);
      });
    } catch {
      return false;
    }
  }

  function getSubtitleExpectedNameToken(site) {
    if (!site) {
      return null;
    }

    if (site.subtitleNameTokenMode === "none") {
      return null;
    }

    try {
      const detail = getSubtitleDetailParts(site);
      if (!detail || detail.detailIndex + 1 >= detail.parts.length) {
        return null;
      }

      if (site.routeIdMode === "numeric_after_subtitle") {
        const candidate = decodeURIComponent(detail.parts[detail.detailIndex + 1]);
        return /^\d+$/.test(candidate) ? candidate : null;
      }

      if (site.routeIdMode === "token_segments") {
        const slug = detail.parts[detail.detailIndex + 1] ? decodeURIComponent(detail.parts[detail.detailIndex + 1]).toLowerCase() : "";
        const maybeLanguage = detail.parts[detail.detailIndex + 2] ? decodeURIComponent(detail.parts[detail.detailIndex + 2]).toLowerCase() : "";
        const maybeId = detail.parts[detail.detailIndex + 3] ? decodeURIComponent(detail.parts[detail.detailIndex + 3]).toLowerCase() : "";
        if (slug && maybeLanguage && maybeId) {
          return `${slug}_${maybeLanguage}_${maybeId}`;
        }
        if (slug && maybeLanguage) {
          return `${slug}_${maybeLanguage}`;
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  function getSubtitleExpectedFileName(site, rawFileName) {
    if (!site) {
      return null;
    }

    if (site.subtitleFileNameMode === "route_slug_zip") {
      const routeSlug = getSubtitleRouteSlug(site);
      return routeSlug ? `${routeSlug}.zip` : null;
    }

    return rawFileName || null;
  }

  function getSubtitleExpectedDirPrefix(site, rawFileName, expectedFileName) {
    const routeToken = getSubtitleExpectedNameToken(site);
    if (site && site.routeIdMode === "numeric_after_subtitle" && routeToken) {
      return routeToken;
    }

    if (site?.subtitleDirPrefixMode === "route_slug_prefix") {
      return getExpectedDirPrefix(getSubtitleRouteSlug(site));
    }

    if (looksLikeOpaqueDownloadToken(rawFileName)) {
      return getExpectedDirPrefix(rawFileName);
    }

    if (expectedFileName) {
      return getExpectedDirPrefix(expectedFileName);
    }

    return null;
  }

  function notifyDownload(target, site) {
    if (state.watcherStarted) {
      return;
    }

    const elementUrl = getElementUrl(target.element);
    const rawFileName = getFileNameFromUrl(elementUrl);
    const isSubtitleSite = !!site;
    const pageFileName = stripHtmlExtension(getFileNameFromUrl(window.location.href));
    const expectedFileName = isSubtitleSite
      ? getSubtitleExpectedFileName(site, rawFileName)
      : (rawFileName || pageFileName);
    const expectedDirPrefix = isSubtitleSite
      ? getSubtitleExpectedDirPrefix(site, rawFileName, expectedFileName)
      : looksLikeOpaqueDownloadToken(rawFileName)
        ? getExpectedDirPrefix(rawFileName)
        : getExpectedDirPrefix(expectedFileName);
    const expectedNameToken = isSubtitleSite && !looksLikeOpaqueDownloadToken(rawFileName)
      ? getSubtitleExpectedNameToken(site)
      : null;

    state.watcherStarted = true;
    chrome.runtime.sendMessage({
      type: "watch-start-download",
      pageUrl: window.location.href,
      elementUrl,
      expectedFileName,
      expectedDirPrefix,
      expectedNameToken,
      triggeredAt: Date.now(),
      timeoutMs: WATCH_TIMEOUT_MS
    });
  }

  function openUrlInNewTab(url) {
    if (!url || state.openedSubtitleUrls.has(url)) {
      return;
    }

    state.openedSubtitleUrls.add(url);
    chrome.runtime.sendMessage({
      type: "open-new-tab",
      url
    });
  }

  function buildListingCandidates(site) {
    if (!site) {
      return [];
    }

    if (site.listingParser === "subsource_table") {
      const rows = document.querySelectorAll("table tr, tbody tr, tr");
      const candidates = [];

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
        const desiredLanguage = cellLabel.includes("korean") ? "korean" : cellLabel.includes("english") ? "english" : "";
        if (!desiredLanguage) {
          continue;
        }

        const links = row.querySelectorAll("a[href]");
        for (const link of links) {
          if (!(link instanceof HTMLElement) || !isClickable(link)) {
            continue;
          }

          const href = getElementUrl(link);
          if (!href || !hrefMatchesCurrentListingRoute(site, href)) {
            continue;
          }

          try {
            const hrefPath = new URL(href).pathname.toLowerCase();
            if (!site.detailPrefixes.some((prefix) => hrefPath.startsWith(prefix))) {
              continue;
            }

            if (!hrefPath.includes(`/${desiredLanguage}/`)) {
              continue;
            }
          } catch {
            continue;
          }

          candidates.push({ language: desiredLanguage, href, element: link });
          break;
        }
      }

      return candidates;
    }

    if (site.listingParser === "subscene_table") {
      const rows = document.querySelectorAll("table tbody tr");
      const candidates = [];

      for (const row of rows) {
        if (!(row instanceof HTMLTableRowElement)) {
          continue;
        }

        const firstCell = row.querySelector("td.a1, td:first-child");
        const link = firstCell?.querySelector("a[href]");
        if (!(link instanceof HTMLElement) || !isClickable(link)) {
          continue;
        }

        const href = getElementUrl(link);
        const languageText = firstCell?.querySelector("span.l")?.textContent || firstCell?.textContent;
        const language = getLanguageFromText(languageText);
        if (!language) {
          continue;
        }

        candidates.push({ language, href, element: link });
      }

      return candidates;
    }

    if (site.listingParser === "ytssubs_table") {
      const rows = document.querySelectorAll("table.other-subs tbody tr, table tbody tr");
      const candidates = [];

      for (const row of rows) {
        if (!(row instanceof HTMLTableRowElement)) {
          continue;
        }

        const languageText = row.querySelector(".sub-lang")?.textContent || row.querySelector("td:nth-child(2)")?.textContent;
        const language = getLanguageFromText(languageText);
        if (!language) {
          continue;
        }

        const link = row.querySelector("a.subtitle-download[href], td.download-cell a[href], a[href]");
        if (!(link instanceof HTMLElement) || !isClickable(link)) {
          continue;
        }

        const href = getElementUrl(link);
        if (!href) {
          continue;
        }

        try {
          const hrefPath = new URL(href).pathname.toLowerCase();
          if (!site.detailPrefixes.some((prefix) => hrefPath.startsWith(prefix))) {
            continue;
          }
        } catch {
          continue;
        }

        candidates.push({ language, href, element: link });
      }

      return candidates;
    }

    return [];
  }

  function clickSubtitleListingTargets(site) {
    const candidates = buildListingCandidates(site);
    if (candidates.length > 0) {
      state.listingSawCandidates = true;
    }
    let openedAny = false;

    for (const candidate of candidates) {
      const key = `${candidate.language}|${candidate.href}`;
      if (
        candidate.element.getAttribute(CLICK_MARK_ATTR) === "1" ||
        state.subtitleClickedKeys.has(key)
      ) {
        continue;
      }

      if (candidate.language === "english" && state.subtitleEnglishOpened) {
        continue;
      }

      state.subtitleClickedKeys.add(key);
      candidate.element.setAttribute(CLICK_MARK_ATTR, "1");
      openUrlInNewTab(candidate.href);
      if (candidate.language === "english") {
        state.subtitleEnglishOpened = true;
      }
      openedAny = true;
    }

    if (openedAny) {
      state.stopListingScroll = true;
    }

    return openedAny;
  }

  async function scrollListingToBottom() {
    let stablePasses = 0;
    let previousHeight = -1;

    while (
      stablePasses < 4 &&
      !state.stopListingScroll &&
      getRouteKey() === currentRouteKey &&
      isSubtitleListingPage()
    ) {
      const currentHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );
      const maxScrollableY = Math.max(0, currentHeight - window.innerHeight);
      const alreadyAtBottom = window.scrollY >= maxScrollableY;

      window.scrollTo({ top: currentHeight, behavior: "auto" });
      await new Promise((resolve) => window.setTimeout(resolve, 400));

      const nextHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );
      const nextMaxScrollableY = Math.max(0, nextHeight - window.innerHeight);
      const atBottom = window.scrollY >= nextMaxScrollableY || Math.ceil(window.innerHeight + window.scrollY) >= nextHeight;
      const noGrowth = nextHeight <= currentHeight;

      if ((alreadyAtBottom && noGrowth) || (nextHeight === previousHeight && atBottom)) {
        stablePasses += 1;
      } else {
        stablePasses = 0;
      }

      previousHeight = nextHeight;
      clickSubtitleListingTargets(getCurrentSubtitleSite());
    }

    if (state.stopListingScroll && !state.listingScrolledBackToTop && getRouteKey() === currentRouteKey) {
      window.scrollTo({ top: 0, behavior: "auto" });
      state.listingScrolledBackToTop = true;
    }
  }

  function ensureSubtitleListingFlow(site) {
    if (!site || !isSubtitleListingPage()) {
      return false;
    }

    clickSubtitleListingTargets(site);

    if (state.listingScrollCompleted || state.stopListingScroll) {
      return true;
    }

    if (!state.listingScrollTask) {
      const routeKeyAtStart = currentRouteKey;
      state.listingScrollTask = scrollListingToBottom()
        .finally(() => {
          if (routeKeyAtStart === currentRouteKey) {
            state.listingScrollTask = null;
            const openedAfterScroll = clickSubtitleListingTargets(site);
            if (state.stopListingScroll || state.listingSawCandidates || openedAfterScroll) {
              state.listingScrollCompleted = true;
            }
          }
        });
    }

    return true;
  }

  function clickSubtitleDetailTarget(site) {
    if (!site || !isSubtitleDetailPage()) {
      return false;
    }

    const candidates = document.querySelectorAll(
      "button, a, input[type='button'], input[type='submit'], [role='button']"
    );

    for (const targetLabel of site.detailLabels) {
      if (state.movieClickedLabels.has(targetLabel)) {
        continue;
      }

      for (const element of candidates) {
        if (!isClickable(element)) {
          continue;
        }

        const label = getElementLabel(element);
        if (!label.includes(targetLabel)) {
          continue;
        }

        state.movieClickedLabels.add(targetLabel);
        notifyDownload({ element, label, targetLabel }, site);
        element.click();
        return true;
      }
    }

    return false;
  }

  function clickMovieTargets(site) {
    if (!site) {
      return false;
    }

    const candidates = document.querySelectorAll(
      "button, a, input[type='button'], input[type='submit'], [role='button']"
    );

    for (const targetLabel of site.labels) {
      if (state.movieClickedLabels.has(targetLabel)) {
        continue;
      }

      for (const element of candidates) {
        if (!isClickable(element)) {
          continue;
        }

        const label = getElementLabel(element);
        if (!label.includes(targetLabel)) {
          continue;
        }

        state.movieClickedLabels.add(targetLabel);
        if (targetLabel === "start download") {
          notifyDownload({ element, label, targetLabel }, null);
        }
        element.click();
        return true;
      }
    }

    return false;
  }

  function processPage() {
    const subtitleSite = getCurrentSubtitleSite();
    if (ensureSubtitleListingFlow(subtitleSite)) {
      return true;
    }

    if (clickSubtitleDetailTarget(subtitleSite)) {
      return true;
    }

    return clickMovieTargets(getCurrentMovieSite());
  }

  function handleRouteChange() {
    const nextRouteKey = getRouteKey();
    if (nextRouteKey === currentRouteKey) {
      return;
    }

    currentRouteKey = nextRouteKey;
    resetRouteState();
    window.requestAnimationFrame(() => {
      processPage();
    });
  }

  function startRouteWatcher() {
    if (routeWatcherStarted || !getCurrentSubtitleSite()) {
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

  function startWatching() {
    if (observerStarted) {
      processPage();
      return;
    }

    observerStarted = true;
    processPage();

    const observer = new MutationObserver(() => {
      processPage();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["value", "aria-label", "title", "href", "data-href", "data-url"]
    });

    if (!getCurrentSubtitleSite()) {
      window.setTimeout(() => {
        observer.disconnect();
      }, WATCH_TIMEOUT_MS);
    }
  }

  async function loadConfig() {
    const response = await fetch(CONFIG_URL);
    return response.json();
  }

  config = await loadConfig();
  startRouteWatcher();
  window.addEventListener("pageshow", () => {
    processPage();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      handleRouteChange();
      processPage();
    }
  });

  if (document.readyState === "complete" || document.readyState === "interactive") {
    startWatching();
  } else {
    window.addEventListener("load", startWatching, { once: true });
  }
})();
