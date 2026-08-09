(() => {
  const defaultSymbol = "¥";
  let currentSymbol = defaultSymbol;
  let previousSymbol = defaultSymbol;

  const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const replaceSymbol = (value, source, target) => {
    if (!source || source === target || !value.includes(source)) return value;
    if (value.trim() === source) return value.replace(source, target);
    return value.replace(new RegExp(`${escaped(source)}(?=\\s*[-+]?(?:\\d|\\.\\d))`, "g"), target);
  };

  const shouldSkip = node => {
    const parent = node.parentElement;
    return !parent
      || parent.closest("script,style,textarea,input,pre,code,[contenteditable=\"true\"]") !== null;
  };

  const updateTextNode = node => {
    if (shouldSkip(node)) return;
    let value = node.nodeValue || "";
    value = replaceSymbol(value, defaultSymbol, currentSymbol);
    value = replaceSymbol(value, previousSymbol, currentSymbol);
    if (value !== node.nodeValue) node.nodeValue = value;
  };

  const updateTree = root => {
    if (root.nodeType === Node.TEXT_NODE) {
      updateTextNode(root);
      return;
    }
    if (!(root instanceof Element) && root !== document) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) updateTextNode(node);
  };

  const setCurrencySymbol = value => {
    const next = String(value ?? "").trim();
    if (!next || next === currentSymbol) return;
    previousSymbol = currentSymbol;
    currentSymbol = next;
    window.__xboardCurrencySymbol = next;
    updateTree(document);
  };

  window.__xboardCurrencySymbol = currentSymbol;
  window.addEventListener("xboard:currency-symbol", event => setCurrencySymbol(event.detail));
  document.addEventListener("input", event => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.name === "currency_symbol") {
      setCurrencySymbol(input.value);
    }
  }, true);

  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "characterData") updateTextNode(record.target);
      record.addedNodes.forEach(updateTree);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  fetch("/api/v1/guest/comm/config", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" }
  }).then(response => response.ok ? response.json() : null)
    .then(payload => setCurrencySymbol(payload?.data?.currency_symbol))
    .catch(() => {});
})();
