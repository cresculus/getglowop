(function () {
  const body = document.body;
  const COLLAPSE_KEY = "glowSideCollapsed";
  const SECTIONS_KEY = "glowSideSections";

  const toggle = document.getElementById("sideToggle");
  function syncToggleLabel() {
    if (!toggle) return;
    toggle.setAttribute(
      "aria-label",
      body.classList.contains("side-collapsed") ? "Expand sidebar" : "Collapse sidebar"
    );
  }
  if (toggle) {
    toggle.addEventListener("click", () => {
      const next = !body.classList.contains("side-collapsed");
      body.classList.toggle("side-collapsed", next);
      try { localStorage.setItem(COLLAPSE_KEY, String(next)); } catch (e) {}
      syncToggleLabel();
    });
  }
  syncToggleLabel();

  const openMenu = () => body.classList.add("side-open");
  const closeMenu = () => body.classList.remove("side-open");
  document.getElementById("sideOpen")?.addEventListener("click", openMenu);
  document.getElementById("sideClose")?.addEventListener("click", closeMenu);
  document.getElementById("sideOverlay")?.addEventListener("click", closeMenu);
  document.querySelectorAll(".side .side-link").forEach((link) => {
    link.addEventListener("click", closeMenu);
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth >= 1024) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SECTIONS_KEY) || "{}") || {}; } catch (e) { saved = {}; }
  document.querySelectorAll(".side-sec[data-sec]").forEach((sec) => {
    const key = sec.dataset.sec;
    const label = sec.querySelector(".side-label[aria-expanded]");
    if (!label) return;
    const apply = (closed) => {
      sec.classList.toggle("is-closed", closed);
      label.setAttribute("aria-expanded", String(!closed));
    };
    apply(saved[key] === true);
    label.addEventListener("click", () => {
      const closed = !sec.classList.contains("is-closed");
      apply(closed);
      saved[key] = closed;
      try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(saved)); } catch (e) {}
    });
  });

  const name = document.getElementById("sideUserName");
  const sub = document.getElementById("sideUserSub");
  if (name && sub) {
    const sync = () => {
      const text = name.textContent.trim();
      const signedIn = text && text !== "Signed out";
      if (signedIn && text.includes("@")) {
        name.textContent = text.split("@")[0];
        sub.textContent = text;
      } else if (!signedIn) {
        sub.textContent = "GLOW Ops";
      }
    };
    new MutationObserver(sync).observe(name, { childList: true, characterData: true, subtree: true });
    sync();
  }
})();
