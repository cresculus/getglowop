/* Quiet Command shell: scope switcher, rail drawer, service badge. Visual layer only —
   pages pass in how to list scopes and what to do on select. */
(function (global) {
  const $ = (id) => document.getElementById(id);
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function yieldToMain() {
    if (global.scheduler && typeof global.scheduler.yield === "function") return global.scheduler.yield();
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function initKbdHints() {
    document.querySelectorAll("[data-qc-kbd]").forEach((el) => {
      el.textContent = isMac ? "⌘K" : "Ctrl K";
    });
  }

  function initRail() {
    const btn = $("qcMenu");
    const backdrop = $("qcBackdrop");
    const rail = document.querySelector(".qc-rail");
    if (!btn || !rail) return;
    const isOpen = () => document.body.classList.contains("qc-rail-open");
    const set = (open) => {
      document.body.classList.toggle("qc-rail-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (backdrop) backdrop.hidden = !open;
      if (open) {
        const target = rail.querySelector('[aria-selected="true"]') || rail.querySelector("button, a");
        if (target) target.focus();
      }
    };
    btn.addEventListener("click", () => set(!isOpen()));
    if (backdrop) backdrop.addEventListener("click", () => set(false));
    rail.addEventListener("click", (e) => {
      if (isOpen() && e.target.closest("[data-pview], [data-view], a[href]")) set(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen()) {
        set(false);
        btn.focus();
      }
    });
  }

  async function initHealth() {
    const box = $("qcHealth");
    const text = $("qcHealthText");
    if (!box || !text) return;
    try {
      const res = await fetch("/api/health", { credentials: "same-origin", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && data.ok !== false;
      box.dataset.state = ok ? "ok" : "warn";
      text.textContent = ok ? "Service healthy" : "Service degraded";
    } catch (_) {
      box.dataset.state = "critical";
      text.textContent = "Service unreachable";
    }
  }

  function setScope({ scope, name, kicker }) {
    const pill = $("qcScope");
    if (!pill) return;
    pill.dataset.scope = scope || "none";
    const nameEl = $("qcScopeName");
    const kickerEl = $("qcScopeKicker");
    if (nameEl && name != null) nameEl.textContent = name;
    if (kickerEl && kicker) kickerEl.textContent = kicker;
    pill.setAttribute("aria-label", `Scope: ${name || "none"}. Switch scope`);
  }

  function initScope({ load, onSelect, enabled }) {
    const dialog = $("qcScopeDialog");
    const input = $("qcScopeQuery");
    const list = $("qcScopeList");
    if (!dialog || !input || !list || typeof dialog.showModal !== "function") return;
    const triggers = [$("qcScope"), $("qcSearch")].filter(Boolean);
    let items = [];
    let shown = [];
    let active = 0;
    let opener = null;
    let seq = 0;

    function paintActive() {
      list.querySelectorAll("[data-index]").forEach((li) => {
        li.setAttribute("aria-selected", Number(li.dataset.index) === active ? "true" : "false");
      });
      const cur = list.querySelector(`[data-index="${active}"]`);
      if (cur) {
        input.setAttribute("aria-activedescendant", cur.id);
        cur.scrollIntoView({ block: "nearest" });
      }
    }

    function render() {
      if (!shown.length) {
        input.removeAttribute("aria-activedescendant");
        list.innerHTML = `<li class="qc-state" data-kind="empty" role="presentation">
          <span>No accounts match “${esc(input.value.trim())}”.</span>
          <button type="button" class="qc-link" data-qc-clear>Clear search</button>
        </li>`;
        return;
      }
      list.innerHTML = shown
        .map(
          (it, i) => `<li id="qcOpt${i}" class="qc-option" role="option" data-index="${i}" data-scope="${esc(it.scope)}" aria-selected="false"${it.current ? ' aria-current="true"' : ""}>
            <span class="qc-scope-dot" aria-hidden="true"></span>
            <span class="qc-option-copy"><b>${esc(it.name)}</b><span>${esc(it.meta || "")}</span></span>
            ${it.current ? '<span class="qc-option-tag">Current</span>' : ""}
          </li>`
        )
        .join("");
      paintActive();
    }

    async function filter() {
      const mine = ++seq;
      await yieldToMain();
      if (mine !== seq) return;
      const q = input.value.trim().toLowerCase();
      shown = q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items.slice();
      const current = shown.findIndex((it) => it.current);
      active = q || current < 0 ? 0 : current;
      render();
    }

    function loadingRows() {
      list.innerHTML = [0, 1, 2]
        .map(() => `<li class="qc-option qc-option-skel" role="presentation"><span class="qc-skel" style="width:60%"></span></li>`)
        .join("");
    }

    async function open(from) {
      if (enabled && !enabled()) return;
      opener = from || document.activeElement;
      input.value = "";
      loadingRows();
      if (!dialog.open) dialog.showModal();
      input.focus();
      try {
        items = await load();
      } catch (err) {
        input.removeAttribute("aria-activedescendant");
        list.innerHTML = `<li class="qc-state" data-kind="error" role="presentation">
          <span>Could not load accounts. ${esc(err && err.message ? err.message : "")}</span>
          <button type="button" class="btn ghost" data-qc-retry>Retry</button>
        </li>`;
        return;
      }
      filter();
    }

    function choose(i) {
      const it = shown[i];
      if (!it) return;
      dialog.close();
      onSelect(it);
    }

    triggers.forEach((t) => t.addEventListener("click", () => open(t)));
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && String(e.key).toLowerCase() === "k") {
        e.preventDefault();
        if (dialog.open) dialog.close();
        else open(triggers[0]);
      }
    });
    input.addEventListener("input", filter);
    input.addEventListener("keydown", (e) => {
      if (!shown.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        active = (active + step + shown.length) % shown.length;
        paintActive();
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        active = e.key === "Home" ? 0 : shown.length - 1;
        paintActive();
      } else if (e.key === "Enter") {
        e.preventDefault();
        choose(active);
      }
    });
    list.addEventListener("click", (e) => {
      if (e.target.closest("[data-qc-clear]")) {
        input.value = "";
        filter();
        input.focus();
        return;
      }
      if (e.target.closest("[data-qc-retry]")) {
        open(opener);
        return;
      }
      const li = e.target.closest("[data-index]");
      if (li) choose(Number(li.dataset.index));
    });
    list.addEventListener("pointermove", (e) => {
      const li = e.target.closest("[data-index]");
      if (li && Number(li.dataset.index) !== active) {
        active = Number(li.dataset.index);
        paintActive();
      }
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    });
  }

  function trendChart(host, points) {
    if (!host) return;
    let rows = Array.isArray(points) ? points.slice() : [];
    if (!rows.length) {
      const today = new Date();
      rows = Array.from({ length: 30 }, (_, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() - (29 - i));
        return { date: d.toISOString().slice(0, 10), reported: 0, checkins: 0 };
      });
    }
    const reported = rows.map((p) => Number(p.reported) || 0);
    const checkins = rows.map((p) => Number(p.checkins) || 0);
    const peak = Math.max(1, ...reported, ...checkins);
    const quiet = reported.every((n) => n === 0) && checkins.every((n) => n === 0);
    const w = Math.max(320, host.clientWidth || 640);
    const h = Math.max(160, host.clientHeight || 200);
    const pad = { l: 36, r: 12, t: 16, b: 28 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    const x = (i) => pad.l + (rows.length === 1 ? iw / 2 : (iw * i) / (rows.length - 1));
    const y = (n) => pad.t + ih - (ih * n) / peak;
    const line = (vals) => vals.map((n, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(" ");
    const area = `${line(reported)} L${x(rows.length - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + ih).toFixed(1)} Z`;
    const ticks = [0, Math.round((rows.length - 1) / 2), rows.length - 1].filter((v, i, a) => a.indexOf(v) === i);
    const labels = ticks
      .map((i) => {
        const day = String(rows[i].date || "").slice(5);
        return `<text x="${x(i).toFixed(1)}" y="${h - 8}" text-anchor="middle">${day}</text>`;
      })
      .join("");
    host.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Devices reported and check-ins over 30 days">
      <line x1="${pad.l}" y1="${pad.t + ih}" x2="${w - pad.r}" y2="${pad.t + ih}" class="trend-axis" />
      <path d="${area}" class="trend-area" />
      <path d="${line(reported)}" class="trend-line" />
      <path d="${line(checkins)}" class="trend-line trend-line-check" />
      ${labels}
    </svg>
    <div class="trend-legend"><span><i class="trend-swatch"></i>Devices reported</span><span><i class="trend-swatch trend-swatch-check"></i>Check-ins</span>${quiet ? `<span class="trend-empty">No check-ins in this window yet.</span>` : ""}</div>`;
  }

  global.GlowQC = {
    trendChart,
    init(opts) {
      initKbdHints();
      initRail();
      initHealth();
      initScope(opts || {});
    },
    setScope,
    esc,
    yieldToMain,
  };
})(window);
