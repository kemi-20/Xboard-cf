(() => {
  const guardedNames = new Set(["email_username", "email_password", "email_from_address"]);
  const guardedSelector = [...guardedNames].map(name => `input[name="${name}"]`).join(",");
  const emailSettingsPath = "/config/fetch?key=email";
  let settingsReady = false;

  const isEmailSettingsRequest = value => String(value || "").includes(emailSettingsPath);

  const unlockForUser = input => {
    if (!settingsReady || input.dataset.xboardEmailGuard !== "true") return;
    input.readOnly = false;
    delete input.dataset.xboardEmailGuard;
  };

  const protectInput = input => {
    if (!(input instanceof HTMLInputElement) || !guardedNames.has(input.name)) return;
    input.setAttribute("data-lpignore", "true");
    input.setAttribute("data-1p-ignore", "true");
    input.autocomplete = input.name === "email_password"
      ? "section-xboard-mail new-password"
      : input.name === "email_from_address"
        ? "section-xboard-mail email"
        : "section-xboard-mail organization";
    if (!settingsReady) {
      input.readOnly = true;
      input.dataset.xboardEmailGuard = "true";
    }
    if (input.dataset.xboardEmailGuardListener !== "true") {
      input.dataset.xboardEmailGuardListener = "true";
      input.addEventListener("pointerdown", () => unlockForUser(input), true);
      input.addEventListener("focus", () => unlockForUser(input), true);
      input.addEventListener("keydown", () => unlockForUser(input), true);
    }
  };

  const protectInputs = root => {
    if (root instanceof HTMLInputElement) protectInput(root);
    root?.querySelectorAll?.(guardedSelector).forEach(protectInput);
  };

  const markReady = () => {
    window.setTimeout(() => {
      settingsReady = true;
      protectInputs(document);
      const active = document.activeElement;
      if (active instanceof HTMLInputElement) unlockForUser(active);
    }, 250);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__xboardEmailSettingsRequest = String(method).toUpperCase() === "GET" && isEmailSettingsRequest(url);
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    if (this.__xboardEmailSettingsRequest) this.addEventListener("loadend", () => {
      if (this.status >= 200 && this.status < 300) markReady();
    }, { once: true });
    return originalSend.apply(this, args);
  };

  if (typeof window.fetch === "function") {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const requestUrl = args[0] instanceof Request ? args[0].url : args[0];
      const response = await originalFetch(...args);
      if (isEmailSettingsRequest(requestUrl) && response.ok) markReady();
      return response;
    };
  }

  new MutationObserver(records => {
    for (const record of records) record.addedNodes.forEach(node => protectInputs(node));
  }).observe(document.documentElement, { childList: true, subtree: true });
  protectInputs(document);
})();
