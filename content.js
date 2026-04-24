(() => {
  const TARGET_LABELS = [
    "download movie",
    "create download link",
    "start download"
  ];

  const CLICK_MARKER = "__kiriAutoClickDone";

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

  function hasTargetLabel(label) {
    return TARGET_LABELS.some((targetLabel) => label.includes(targetLabel));
  }

  function findTarget() {
    const candidates = document.querySelectorAll(
      "button, a, input[type='button'], input[type='submit'], [role='button']"
    );

    for (const element of candidates) {
      if (!isClickable(element)) {
        continue;
      }

      const label = getElementLabel(element);
      if (hasTargetLabel(label)) {
        return element;
      }
    }

    return null;
  }

  function clickOnce() {
    if (window[CLICK_MARKER]) {
      return true;
    }

    const target = findTarget();
    if (!target) {
      return false;
    }

    window[CLICK_MARKER] = true;
    target.click();
    return true;
  }

  function startWatching() {
    if (clickOnce()) {
      return;
    }

    const observer = new MutationObserver(() => {
      if (clickOnce()) {
        observer.disconnect();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.setTimeout(() => {
      observer.disconnect();
    }, 15000);
  }

  if (document.readyState === "complete") {
    startWatching();
  } else {
    window.addEventListener("load", startWatching, { once: true });
  }
})();
