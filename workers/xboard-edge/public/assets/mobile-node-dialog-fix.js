(() => {
  const mobileQuery = window.matchMedia("(max-width: 767px)");
  const nodeDialogTitles = new Set([
    "编辑节点",
    "新建节点",
    "Edit Node",
    "New Node",
    "Изменить узел",
    "Новый узел"
  ]);
  const delayedRefreshes = [50, 200, 500];

  const updateViewportHeight = () => {
    const height = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty("--xboard-visual-viewport-height", `${Math.round(height)}px`);
  };

  const installDialogFix = () => {
    if (!mobileQuery.matches) return;
    updateViewportHeight();

    document.querySelectorAll('[role="dialog"]').forEach(dialog => {
      const title = dialog.querySelector("h1, h2, h3, [data-vaul-title], [id]");
      if (!title || !nodeDialogTitles.has(title.textContent?.trim() || "")) return;

      const body = Array.from(dialog.querySelectorAll("div")).find(element =>
        element.classList.contains("h-[75vh]") && element.classList.contains("min-h-[500px]")
      );
      if (!body) return;

      dialog.classList.add("xboard-mobile-node-dialog");
      body.classList.add("xboard-mobile-node-dialog-body");
      body.parentElement?.classList.add("xboard-mobile-node-dialog-form");
    });
  };

  const refreshAfterViewportChange = () => {
    installDialogFix();
    delayedRefreshes.forEach(delay => window.setTimeout(installDialogFix, delay));
  };

  const observer = new MutationObserver(installDialogFix);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.visualViewport?.addEventListener("resize", refreshAfterViewportChange);
  window.visualViewport?.addEventListener("scroll", refreshAfterViewportChange);
  window.addEventListener("resize", refreshAfterViewportChange);
  window.addEventListener("orientationchange", refreshAfterViewportChange);
  document.addEventListener("focusout", refreshAfterViewportChange, true);
  mobileQuery.addEventListener?.("change", refreshAfterViewportChange);
  installDialogFix();
})();
