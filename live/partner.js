(() => {
  const $ = (id) => document.getElementById(id);
  const loginView = $("loginView");
  const dashView = $("dashView");
  let businessesCache = [];

  function primaryTenant() {
    return businessesCache[0]?.business_id || "demo";
  }

  function syncDashLinks() {
    const t = primaryTenant();
    const base = `from=partner&tenant=${encodeURIComponent(t)}`;
    const fleet = $("navFleet");
    const dash = $("navDash");
    const ingest = $("navIngest");
    const csv = $("navCsv");
    if (fleet) fleet.href = `/app/?${base}&view=fleet`;
    if (dash) dash.href = `/app/?${base}&view=dashboard`;
    if (ingest) ingest.href = `/app/?${base}&view=ingest`;
    if (csv) csv.href = `/api/export.csv?tenant=${encodeURIComponent(t)}`;
    document.querySelectorAll(".side-call[data-call]").forEach((a) => {
      const call = a.getAttribute("data-call");
      a.href = `/app/?${base}&view=fleet&call=${encodeURIComponent(call)}`;
    });
  }

  function mcpBase() {
    return `${window.location.origin}/mcp`;
  }

  function renderConfig(apiKeyPlaceholder) {
    const key = apiKeyPlaceholder || "gow_mcp_YOUR_KEY";
    const cfg = $("mcpConfig");
    const urlEl = $("mcpUrl");
    if (cfg) {
      cfg.textContent = JSON.stringify(
        {
          mcpServers: {
            glowops: {
              url: mcpBase(),
              headers: { Authorization: `Bearer ${key}` },
            },
          },
        },
        null,
        2
      );
    }
    if (urlEl) urlEl.textContent = mcpBase().replace(/^https?:\/\//, "");
  }

  function setPView(name) {
    const map = {
      home: "pviewHome",
      enroll: "pviewEnroll",
      biz: "pviewBiz",
      analyze: "pviewAnalyze",
      settings: "pviewSettings",
    };
    if (!map[name]) name = "home";
    Object.entries(map).forEach(([key, id]) => {
      const el = $(id);
      if (!el) return;
      const on = key === name;
      el.hidden = !on;
      el.dataset.active = on ? "true" : "false";
    });
    document.querySelectorAll("[data-pview]").forEach((tab) => {
      tab.setAttribute("aria-selected", tab.getAttribute("data-pview") === name ? "true" : "false");
    });
    if (name === "home") renderHome();
    if (name === "analyze") renderAnalyze();
  }

  let clerkToken = null;
  let clerkEnabled = false;

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (clerkToken) headers.Authorization = `Bearer ${clerkToken}`;
    const res = await fetch(path, {
      credentials: "same-origin",
      ...opts,
      headers,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
    return data;
  }

  async function initClerk() {
    try {
      const cfg = await fetch("/api/config/public").then((r) => r.json());
      clerkEnabled = !!(cfg.clerk && cfg.clerk.enabled && cfg.clerk.publishableKey);
      if (!clerkEnabled) return false;
      const pk = cfg.clerk.publishableKey;
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js";
        s.async = true;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
      const Clerk = window.Clerk;
      if (!Clerk) return false;
      window.__glowClerk = new Clerk(pk);
      await window.__glowClerk.load();
      const mount = $("clerkMount");
      const box = $("clerkSignIn");
      const form = $("loginForm");
      if (box) box.hidden = false;
      if (form) form.hidden = true;
      if (window.__glowClerk.session) {
        clerkToken = await window.__glowClerk.session.getToken();
        const me = await api("/api/partner/me");
        showDash(me.partner);
        return true;
      }
      if (mount) {
        window.__glowClerk.mountSignIn(mount, {
          afterSignInUrl: "/partner/",
          afterSignUpUrl: "/partner/",
        });
      }
      window.__glowClerk.addListener(async ({ session }) => {
        if (!session) {
          clerkToken = null;
          showLogin();
          return;
        }
        clerkToken = await session.getToken();
        try {
          const me = await api("/api/partner/me");
          showDash(me.partner);
        } catch (err) {
          if ($("loginErr")) $("loginErr").textContent = String(err.message || err);
        }
      });
      return true;
    } catch (err) {
      console.warn("Clerk init skipped", err);
      return false;
    }
  }

  function showDash(me) {
    if (!me) {
      showLogin();
      return;
    }
    document.body.classList.add("is-authed");
    loginView.hidden = true;
    dashView.hidden = false;
    $("logoutBtn").hidden = false;
    const homeBtn = $("homeBtn");
    if (homeBtn) homeBtn.hidden = false;
    $("partnerHello").hidden = false;
    $("partnerHello").textContent = me.email || me.name || "";
    renderConfig();
    setPView("home");
    refresh().catch((err) => {
      console.error(err);
      $("loginErr").textContent = String(err.message || err);
    });
  }

  function showLogin() {
    document.body.classList.remove("is-authed");
    loginView.hidden = false;
    dashView.hidden = true;
    $("logoutBtn").hidden = true;
    const homeBtn = $("homeBtn");
    if (homeBtn) homeBtn.hidden = true;
    $("partnerHello").hidden = true;
  }

  async function renderHome() {
    const kpis = $("homeKpis");
    const bars = $("homeCallBars");
    const list = $("homeBizList");
    if (!kpis || !bars || !list) return;
    kpis.innerHTML = `
      <div><span>Businesses</span><strong>…</strong></div>
      <div><span>Devices</span><strong>…</strong></div>
      <div><span>Avg GLOW</span><strong>…</strong></div>
      <div><span>Ghosts</span><strong>…</strong></div>
      <div><span>Repair</span><strong>…</strong></div>
      <div><span>Mfg kg</span><strong>…</strong></div>`;
    bars.innerHTML = "";
    list.innerHTML = "<li>Loading portfolio…</li>";
    try {
      const p = await api("/api/partner/portfolio");
      const by = p.byCall || {};
      const total = Math.max(1, p.deviceCount || 1);
      kpis.innerHTML = `
        <div><span>Businesses</span><strong>${esc(p.businessCount ?? 0)}</strong></div>
        <div><span>Devices</span><strong>${esc(p.deviceCount ?? 0)}</strong></div>
        <div><span>Avg GLOW</span><strong>${esc(p.avgGlowScore ?? "—")}</strong></div>
        <div><span>Ghosts</span><strong>${esc(p.ghostCount ?? 0)}</strong></div>
        <div><span>Repair</span><strong>${esc(p.repairCount ?? 0)}</strong></div>
        <div><span>Mfg kg</span><strong>${esc(p.manufacturingKgOnBooks ?? 0)}</strong></div>`;
      bars.innerHTML = ["keep", "repair", "redeploy", "refresh", "recycle", "ghost"]
        .map((c) => {
          const n = by[c] || 0;
          const pct = Math.round((100 * n) / total);
          return `<div class="dash-bar"><span>${c}</span><div class="track"><i style="width:${pct}%"></i></div><b>${n}</b></div>`;
        })
        .join("");
      const rows = p.businesses || [];
      if (!rows.length) {
        list.innerHTML = `<li class="hint">No businesses yet — add one under Businesses.</li>`;
      } else {
        list.innerHTML = rows
          .map((b) => {
            const href = `/app/?from=partner&tenant=${encodeURIComponent(b.businessId)}&view=fleet`;
            return `<li>
              <a class="home-biz-row" href="${href}">
                <strong>${esc(b.businessName || b.businessId)}</strong>
                <span>${esc(b.deviceCount)} devices · GLOW ${esc(b.avgGlowScore ?? "—")} · ghosts ${esc(b.ghostCount)}</span>
              </a>
            </li>`;
          })
          .join("");
      }
    } catch (err) {
      list.innerHTML = `<li class="hint">${esc(err.message || err)}</li>`;
    }
  }

  async function renderAnalyze() {
    const grid = $("analyzeGrid");
    if (!grid) return;
    if (!businessesCache.length) {
      grid.innerHTML = `<p class="view-lede">No businesses assigned yet.</p>`;
      return;
    }
    grid.innerHTML = businessesCache
      .map((b) => {
        const href = `/app/?from=partner&tenant=${encodeURIComponent(b.business_id)}&view=fleet`;
        return `<a class="analyze-card analyze-card-link" href="${href}" data-biz="${esc(b.business_id)}">
        <h3>${esc(b.business_name || b.business_id)}</h3>
        <div class="meta-line">${esc(b.business_id)}</div>
        <div class="kpis" id="an-${esc(b.business_id)}"><span>Loading…</span></div>
        <span class="btn lime open-report-label">Open report</span>
      </a>`;
      })
      .join("");

    await Promise.all(
      businessesCache.map(async (b) => {
        const slot = document.getElementById(`an-${b.business_id}`);
        if (!slot) return;
        try {
          const s = await api(`/api/summary?tenant=${encodeURIComponent(b.business_id)}`);
          slot.innerHTML = `
            <div><span>Devices</span> <strong>${s.deviceCount ?? 0}</strong></div>
            <div><span>Avg GLOW</span> <strong>${s.avgGlowScore ?? "—"}</strong></div>
            <div><span>Ghosts</span> <strong>${s.ghostCount ?? 0}</strong></div>
            <div><span>Repair</span> <strong>${s.repairBeforeReplaceCount ?? 0}</strong></div>`;
        } catch {
          slot.innerHTML = `<span>Could not load summary</span>`;
        }
      })
    );
  }

  async function refresh() {
    const [biz, keys, enroll] = await Promise.all([
      api("/api/partner/businesses"),
      api("/api/partner/mcp-keys"),
      api("/api/partner/enrollment-keys"),
    ]);
    businessesCache = biz.businesses || [];
    syncDashLinks();
    $("bizCount").textContent = businessesCache.length;
    const bizSelect = $("enrollBiz");
    if (bizSelect) {
      bizSelect.innerHTML = businessesCache
        .map(
          (b) =>
            `<option value="${esc(b.business_id)}">${esc(b.business_name || b.business_id)}</option>`
        )
        .join("");
    }
    $("bizList").innerHTML = businessesCache
      .map((b) => {
        const href = `/app/?from=partner&tenant=${encodeURIComponent(b.business_id)}&view=fleet`;
        return `<li class="biz-tile">
          <a class="biz-tile-link" href="${href}" title="Open report">
            <span><b>${esc(b.business_name || b.business_id)}</b><div class="hint">${esc(
              b.business_id
            )}</div></span>
            <span class="btn lime open-report-label">Open report</span>
          </a>
        </li>`;
      })
      .join("");
    const active = (keys.keys || []).filter((k) => !k.revoked_at);
    $("keyCount").textContent = active.length;
    $("keysBody").innerHTML = (keys.keys || [])
      .map((k) => {
        const revoked = !!k.revoked_at;
        return `<tr>
          <td>${esc(k.label)}</td>
          <td><code>${esc(k.key_prefix)}…</code></td>
          <td>${esc(k.scopes)}</td>
          <td>${esc((k.created_at || "").slice(0, 10))}</td>
          <td>${esc((k.last_used_at || "—").toString().slice(0, 10))}</td>
          <td>${
            revoked
              ? "<em>revoked</em>"
              : `<button type="button" class="btn ghost danger" data-revoke="${esc(k.id)}">Revoke</button>`
          }</td>
        </tr>`;
      })
      .join("");
    $("enrollBody").innerHTML = (enroll.keys || [])
      .map((k) => {
        const status = k.status || "active";
        return `<tr>
          <td>${esc(k.label)}</td>
          <td>${esc(k.business_id)}</td>
          <td><code>${esc(k.key_code)}</code></td>
          <td>${esc(status)}</td>
          <td>${esc((k.expires_at || "").slice(0, 16).replace("T", " "))}</td>
          <td>${esc(k.use_count ?? 0)}</td>
          <td>${
            status === "active"
              ? `<button type="button" class="btn ghost danger" data-revoke-enroll="${esc(k.id)}">Revoke</button>`
              : "—"
          }</td>
        </tr>`;
      })
      .join("");

    if ($("pviewHome")?.dataset.active === "true") renderHome();
    if ($("pviewAnalyze")?.dataset.active === "true") renderAnalyze();
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  document.querySelectorAll("[data-pview]").forEach((tab) => {
    tab.addEventListener("click", () => setPView(tab.getAttribute("data-pview")));
  });

  const loginForm = $("loginForm");
  const loginBtn = loginForm ? loginForm.querySelector('button[type="submit"]') : null;
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      $("loginErr").textContent = "";
      if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.textContent = "Signing in…";
      }
      try {
        const me = await api("/api/partner/login", {
          method: "POST",
          body: JSON.stringify({ email: $("email").value, password: $("password").value }),
        });
        showDash(me.partner);
      } catch (err) {
        $("loginErr").textContent = String(err.message || err);
      } finally {
        if (loginBtn) {
          loginBtn.disabled = false;
          loginBtn.textContent = "Sign in";
        }
      }
    });
  }

  const logoutBtn = $("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        if (window.__glowClerk) await window.__glowClerk.signOut({ redirectUrl: "/partner/" });
        await api("/api/partner/logout", { method: "POST", body: "{}" });
      } catch (_) {}
      clerkToken = null;
      showLogin();
      if (clerkEnabled) initClerk();
    });
  }

  const addBizForm = $("addBizForm");
  if (addBizForm) {
    addBizForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const st = $("addBizStatus");
      const name = ($("newBizName")?.value || "").trim();
      const id = ($("newBizId")?.value || "").trim();
      if (!name) {
        if (st) st.textContent = "Name required";
        return;
      }
      if (st) st.textContent = "Adding…";
      try {
        const created = await api("/api/partner/businesses", {
          method: "POST",
          body: JSON.stringify({ name, businessId: id || undefined }),
        });
        if (st) st.textContent = `Added ${created.business?.business_name || name}`;
        if ($("newBizName")) $("newBizName").value = "";
        if ($("newBizId")) $("newBizId").value = "";
        await refresh();
        renderHome();
      } catch (err) {
        if (st) st.textContent = String(err.message || err);
      }
    });
  }

  const enrollForm = $("enrollForm");
  if (enrollForm) {
    enrollForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const minted = await api("/api/partner/enrollment-keys", {
          method: "POST",
          body: JSON.stringify({
            businessId: $("enrollBiz").value,
            ttlHours: Number($("enrollTtl").value || 24),
            label: $("enrollLabel").value || "Device join",
          }),
        });
        $("freshEnroll").hidden = false;
        $("freshJoinKey").textContent = minted.joinKey;
        $("freshJoinPass").textContent = minted.joinPassword;
        $("freshJoinExp").textContent = `Expires ${minted.expiresAt} · scope ${minted.scope} · TTL ${minted.ttlHours}h`;
        $("enrollLabel").value = "";
        await refresh();
      } catch (err) {
        alert(String(err.message || err));
      }
    });
  }

  const copyEnroll = $("copyEnroll");
  if (copyEnroll) {
    copyEnroll.addEventListener("click", async () => {
      const text = `Join Key: ${$("freshJoinKey").textContent}\nJoin Password: ${$("freshJoinPass").textContent}`;
      try {
        await navigator.clipboard.writeText(text);
        copyEnroll.textContent = "Copied";
      } catch (_) {
        copyEnroll.textContent = "Copy";
      }
    });
  }

  const enrollBody = $("enrollBody");
  if (enrollBody) {
    enrollBody.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-revoke-enroll]");
      if (!btn) return;
      if (!confirm("Revoke this join key? Agents using it will fail closed.")) return;
      try {
        await api(
          `/api/partner/enrollment-keys/${encodeURIComponent(btn.getAttribute("data-revoke-enroll"))}/revoke`,
          { method: "POST", body: "{}" }
        );
        await refresh();
      } catch (err) {
        alert(String(err.message || err));
      }
    });
  }

  const mintForm = $("mintForm");
  if (mintForm) {
    mintForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const label = $("keyLabel").value || "MCP key";
      try {
        const minted = await api("/api/partner/mcp-keys", {
          method: "POST",
          body: JSON.stringify({ label }),
        });
        $("freshKey").hidden = false;
        $("freshKeyValue").textContent = minted.apiKey;
        renderConfig(minted.apiKey);
        $("keyLabel").value = "";
        await refresh();
      } catch (err) {
        alert(String(err.message || err));
      }
    });
  }

  const copyKey = $("copyKey");
  if (copyKey) {
    copyKey.addEventListener("click", async () => {
      const v = $("freshKeyValue").textContent;
      try {
        await navigator.clipboard.writeText(v);
        copyKey.textContent = "Copied";
      } catch (_) {
        copyKey.textContent = "Copy";
      }
    });
  }

  const keysBody = $("keysBody");
  if (keysBody) {
    keysBody.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-revoke]");
      if (!btn) return;
      if (!confirm("Revoke this MCP key?")) return;
      try {
        await api(`/api/partner/mcp-keys/${encodeURIComponent(btn.getAttribute("data-revoke"))}/revoke`, {
          method: "POST",
          body: "{}",
        });
        await refresh();
      } catch (err) {
        alert(String(err.message || err));
      }
    });
  }

  showLogin();
  initClerk().then((usedClerk) => {
    if (usedClerk) return;
    api("/api/partner/me")
      .then((data) => showDash(data.partner))
      .catch(() => showLogin());
  });
})();
