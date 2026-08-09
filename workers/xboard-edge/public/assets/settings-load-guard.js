(() => {
  const routeKeys = new Map([
    ["/config/system", "site"],
    ["/config/system/safe", "safe"],
    ["/config/system/subscribe", "subscribe"],
    ["/config/system/invite", "invite"],
    ["/config/system/server", "server"],
    ["/config/system/email", "email"],
    ["/config/system/telegram", "telegram"],
    ["/config/system/app", "app"],
    ["/config/system/subscribe-template", "subscribe_template"]
  ]);
  const readyKeys = new Set();
  const composingControls = new WeakSet();
  const emailCredentialNames = new Set(["email_username", "email_password", "email_from_address"]);
  const controlSelector = "input,textarea,select,button[role=\"switch\"],button[role=\"combobox\"]";

  const currentRoute = () => location.hash.replace(/^#/, "").split("?")[0].replace(/\/$/, "") || "/";
  const currentKey = () => routeKeys.get(currentRoute()) || null;
  const requestKey = value => {
    try {
      const url = new URL(String(value || ""), location.href);
      if (!url.pathname.endsWith("/config/fetch")) return null;
      const key = url.searchParams.get("key");
      return key && [...routeKeys.values()].includes(key) ? key : null;
    } catch {
      return null;
    }
  };

  const isSettingsControl = control => {
    if (!(control instanceof HTMLElement) || !control.matches(controlSelector)) return false;
    if (!control.closest("main") || control.closest("nav")) return false;
    return control instanceof HTMLInputElement
      || control instanceof HTMLTextAreaElement
      || control instanceof HTMLSelectElement
      || control.getAttribute("role") === "switch"
      || control.getAttribute("role") === "combobox";
  };

  const unlockEmailCredential = input => {
    if (!readyKeys.has("email") || input.dataset.xboardRequiresUserUnlock !== "true") return;
    input.readOnly = false;
    delete input.dataset.xboardSettingsGuard;
    delete input.dataset.xboardRequiresUserUnlock;
    input.removeAttribute("aria-disabled");
    input.removeAttribute("title");
  };

  const protectEmailCredential = input => {
    input.setAttribute("data-lpignore", "true");
    input.setAttribute("data-1p-ignore", "true");
    input.autocomplete = input.name === "email_password"
      ? "section-xboard-mail new-password"
      : input.name === "email_from_address"
        ? "section-xboard-mail email"
        : "section-xboard-mail organization";
    if (input.dataset.xboardEmailGuardListener !== "true") {
      input.dataset.xboardEmailGuardListener = "true";
      input.addEventListener("pointerdown", () => unlockEmailCredential(input), true);
      input.addEventListener("focus", () => unlockEmailCredential(input), true);
      input.addEventListener("keydown", () => unlockEmailCredential(input), true);
    }
  };

  const updateControl = control => {
    if (!isSettingsControl(control)) return;
    const key = currentKey();
    if (!key) return;
    const emailCredential = control instanceof HTMLInputElement && emailCredentialNames.has(control.name);
    if (emailCredential) protectEmailCredential(control);
    const locked = !readyKeys.has(key) || (emailCredential && control.dataset.xboardRequiresUserUnlock === "true");
    if (locked) {
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) control.readOnly = true;
      control.dataset.xboardSettingsGuard = "true";
      if (emailCredential) control.dataset.xboardRequiresUserUnlock = "true";
      control.setAttribute("aria-disabled", "true");
      control.title = "配置加载完成后才可修改";
      return;
    }
    if (control.dataset.xboardSettingsGuard === "true") {
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) control.readOnly = false;
      delete control.dataset.xboardSettingsGuard;
      control.removeAttribute("aria-disabled");
      control.removeAttribute("title");
    }
  };

  const updateControls = root => {
    if (root instanceof HTMLElement && root.matches(controlSelector)) updateControl(root);
    root?.querySelectorAll?.(controlSelector).forEach(updateControl);
  };

  const markReady = key => {
    if (!key) return;
    window.setTimeout(() => {
      readyKeys.add(key);
      updateControls(document);
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && emailCredentialNames.has(active.name)) unlockEmailCredential(active);
    }, 250);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__xboardSettingsKey = String(method).toUpperCase() === "GET" ? requestKey(url) : null;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const key = this.__xboardSettingsKey;
    if (key) this.addEventListener("loadend", () => {
      if (this.status >= 200 && this.status < 300) markReady(key);
    }, { once: true });
    return originalSend.apply(this, args);
  };

  if (typeof window.fetch === "function") {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const requestUrl = args[0] instanceof Request ? args[0].url : args[0];
      const key = requestKey(requestUrl);
      const response = await originalFetch(...args);
      if (key && response.ok) markReady(key);
      return response;
    };
  }

  const blockPrematureChange = event => {
    const control = event.target instanceof Element ? event.target.closest(controlSelector) : null;
    if (!control || !isSettingsControl(control)) return;
    const key = currentKey();
    const requiresUserUnlock = control.dataset.xboardRequiresUserUnlock === "true";
    if (key && (!readyKeys.has(key) || requiresUserUnlock)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  const settingsControlFromEvent = event => {
    const control = event.target instanceof Element ? event.target.closest(controlSelector) : null;
    return control && isSettingsControl(control) ? control : null;
  };

  document.addEventListener("compositionstart", event => {
    const control = settingsControlFromEvent(event);
    if (control) composingControls.add(control);
  }, true);
  document.addEventListener("compositionend", event => {
    const control = settingsControlFromEvent(event);
    if (!control) return;
    composingControls.delete(control);
    queueMicrotask(() => {
      if (document.contains(control)) control.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }, true);

  const blockComposingChange = event => {
    const control = settingsControlFromEvent(event);
    if (control && composingControls.has(control)) event.stopImmediatePropagation();
  };
  for (const eventName of ["beforeinput", "input", "change", "click"]) {
    document.addEventListener(eventName, blockComposingChange, true);
    document.addEventListener(eventName, blockPrematureChange, true);
  }

  new MutationObserver(records => {
    for (const record of records) record.addedNodes.forEach(node => updateControls(node));
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("hashchange", () => updateControls(document));
  updateControls(document);
})();
