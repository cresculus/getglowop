(() => {
  const $ = (id) => document.getElementById(id);
  const loginView = $("loginView");
  const dashView = $("dashView");
  let businessesCache = [];

  const DEFAULT_DASH_URL = "https://getglowop.com";
  let dashboardUrl = DEFAULT_DASH_URL;

  function mcpBase() {
    return `${window.location.origin}/mcp`;
  }

  function setEnrollDashUrl(url) {
    const next = (url || DEFAULT_DASH_URL).trim().replace(/\/+$/, "") || DEFAULT_DASH_URL;
    dashboardUrl = next;
    ["enrollDashUrl", "freshDashUrl"].forEach((id) => {
      const el = $(id);
      if (el) el.textContent = next;
    });
  }

  function setSideIdentity(name, role) {
    const nameEl = $("sideUserName");
    const roleEl = $("partnerRoleLabel");
    if (nameEl && name) nameEl.textContent = name;
    if (roleEl) roleEl.textContent = role || "Partner";
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
      people: "pviewPeople",
      analyze: "pviewAnalyze",
      resources: "pviewResources",
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
    if (name === "people") renderPeople();
  }

  let clerkToken = null;
  let clerkEnabled = false;
  let meRoles = [];
  let peopleCanManage = false;

  async function refreshClerkToken() {
    try {
      const clerk = window.__glowClerk;
      if (clerk?.session && typeof clerk.session.getToken === "function") {
        const fresh = await clerk.session.getToken();
        if (fresh) clerkToken = fresh;
      } else if (window.GlowClerkPartner?.sessionToken && clerk) {
        const fresh = await window.GlowClerkPartner.sessionToken(clerk);
        if (fresh) clerkToken = fresh;
      }
    } catch (_) {
      /* keep prior token */
    }
    return clerkToken;
  }

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    // Clerk session JWTs expire quickly — refresh before every Partner API call.
    await refreshClerkToken();
    if (clerkToken) headers.Authorization = `Bearer ${clerkToken}`;
    const res = await fetch(path, {
      credentials: "same-origin",
      ...opts,
      headers,
    });
    // One retry on 401 after forcing a fresh token (common after idle / long mint form).
    if (res.status === 401 && window.__glowClerk?.session) {
      clerkToken = null;
      await refreshClerkToken();
      if (clerkToken) {
        headers.Authorization = `Bearer ${clerkToken}`;
        const retry = await fetch(path, {
          credentials: "same-origin",
          ...opts,
          headers,
        });
        const retryData = await retry.json().catch(() => ({}));
        if (!retry.ok) throw new Error(retryData.error || retryData.message || `HTTP ${retry.status}`);
        return retryData;
      }
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
    return data;
  }

  function hideWelcome() {
    const w = document.getElementById("glowWelcome");
    if (w) w.remove();
  }

  function mountClerkSignIn() {
    const signIn = (window.GlowClerkPartner && GlowClerkPartner.SIGN_IN) || "/partner/sign-in";
    const bounced = sessionStorage.getItem("glowConsoleBounce") === "1";
    if (bounced) sessionStorage.removeItem("glowConsoleBounce");
    else sessionStorage.setItem("glowConsoleBounce", "1");
    location.replace(bounced ? signIn : signIn + "?next=" + encodeURIComponent("/partner/"));
  }

  async function afterClerkSession(session) {
    if (!session) {
      clerkToken = null;
      showLogin();
      if (clerkEnabled) mountClerkSignIn();
      return;
    }
    clerkToken = await session.getToken();
    try {
      const me = await api("/api/partner/me");
      showDash(me.partner, me.roles || []);
    } catch (err) {
      hideWelcome();
      if ($("loginErr")) {
        $("loginErr").textContent =
          String(err.message || err) +
          " — if this persists, confirm CLERK_SECRET_KEY is set on Railway and redeploy.";
      }
    }
  }

  async function initClerk() {
    try {
      if (!window.GlowClerkPartner) return false;
      const cfg = await GlowClerkPartner.fetchPublicConfig();
      const c = cfg.clerk || {};
      clerkEnabled = !!(c.enabled && c.publishableKey);
      const form = $("loginForm");
      const mount = $("clerkMount");
      const lede = $("dashGateLede");
      if (!clerkEnabled) {
        hideWelcome();
        if (lede) {
          lede.hidden = false;
          lede.textContent = c.secretSet
            ? "Clerk publishable key missing on Railway (CLERK_PUBLISHABLE_KEY)."
            : "Clerk keys not set on Railway (need CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY).";
        }
        return false;
      }
      if (form) form.hidden = true;
      if (lede) lede.hidden = true;
      if (mount) mount.hidden = false;
      if (!c.verifyReady || !c.secretSet) {
        if ($("loginErr")) {
          $("loginErr").textContent =
            "CLERK_SECRET_KEY missing on Railway — check /api/health clerkSecretSet.";
        }
      }
      const clerk = await GlowClerkPartner.createClerk(c.publishableKey);
      if (clerk.session) {
        await afterClerkSession(clerk.session);
        return true;
      }
      mountClerkSignIn();
      clerk.addListener(async ({ session }) => {
        await afterClerkSession(session);
      });
      return true;
    } catch (err) {
      console.warn("Clerk init skipped", err);
      hideWelcome();
      if ($("loginErr")) $("loginErr").textContent = "Clerk failed to load: " + String(err.message || err);
      return false;
    }
  }

  function showDash(me, roles) {
    if (!me) {
      showLogin();
      return;
    }
    meRoles = roles || [];
    try { sessionStorage.removeItem("glowConsoleBounce"); } catch (e) {}
    hideWelcome();
    document.body.classList.add("is-authed");
    loginView.hidden = true;
    dashView.hidden = false;
    const clerkUser = window.__glowClerk && window.__glowClerk.user;
    const who =
      (clerkUser && clerkUser.primaryEmailAddress && clerkUser.primaryEmailAddress.emailAddress) ||
      me.email ||
      me.name ||
      "Signed in";
    setSideIdentity(who, "Partner");
    const ub = $("partnerUserButton");
    if (window.__glowClerk && window.GlowClerkPartner && ub) {
      GlowClerkPartner.mountUserButton(window.__glowClerk, ub);
      $("logoutBtn").hidden = true;
    } else {
      if (ub) ub.hidden = true;
      $("logoutBtn").hidden = false;
    }
    renderConfig();
    const params = new URLSearchParams(location.search);
    const want = params.get("view");
    const allowed = new Set(["home", "enroll", "biz", "people", "analyze", "resources", "settings"]);
    setPView(allowed.has(want) ? want : "home");
    refresh()
      .then(() => {
        const tenantPref = params.get("tenant");
        const enrollBiz = $("enrollBiz");
        if (tenantPref && enrollBiz) {
          const hit = [...enrollBiz.options].some((o) => o.value === tenantPref);
          if (hit) enrollBiz.value = tenantPref;
        }
        return finishIntuneConsent();
      })
      .catch((err) => {
        console.error(err);
        if ($("loginErr")) $("loginErr").textContent = String(err.message || err);
      });
  }

  function showLogin() {
    document.body.classList.remove("is-authed");
    loginView.hidden = false;
    dashView.hidden = true;
    $("logoutBtn").hidden = true;
    const ub = $("partnerUserButton");
    if (ub) {
      ub.hidden = true;
      ub.innerHTML = "";
    }
    const chip = $("partnerRoleChip");
    if (chip) chip.hidden = true;
    if (clerkEnabled) {
      const form = $("loginForm");
      if (form) form.hidden = true;
      const mount = $("clerkMount");
      if (mount) mount.hidden = false;
      const lede = $("dashGateLede");
      if (lede) lede.hidden = true;
    } else {
      const form = $("loginForm");
      if (form) form.hidden = false;
      const mount = $("clerkMount");
      if (mount) mount.hidden = true;
      const lede = $("dashGateLede");
      if (lede) {
        lede.hidden = false;
        lede.textContent = "Lab password login (Clerk keys not set on Railway).";
      }
    }
  }

  async function renderHome() {
    const kpis = $("homeKpis");
    const bars = $("homeCallBars");
    const list = $("homeBizList");
    if (!kpis || !bars || !list) return;
    kpis.innerHTML = `
      <div><span>Businesses</span><strong>…</strong></div>
      <div><span>Devices</span><strong>…</strong></div>
      <div><span class="glow-mark">Avg GLOW<sup class="tm" aria-label="trademark">™</sup></span><strong>…</strong></div>
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
        <div><span class="glow-mark">Avg GLOW<sup class="tm" aria-label="trademark">™</sup></span><strong>${esc(p.avgGlowScore ?? "—")}</strong></div>
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
                <strong>${esc(b.businessName || "Business")}</strong>
                <span>${esc(b.deviceCount)} devices · GLOW™ ${esc(b.avgGlowScore ?? "—")} · ghosts ${esc(b.ghostCount)}</span>
              </a>
            </li>`;
          })
          .join("");
      }
    } catch (err) {
      list.innerHTML = `<li class="hint">${esc(err.message || err)}</li>`;
    }
  }

  async function renderPeople() {
    const sel = $("peopleBiz");
    const membersBody = $("membersBody");
    const invitesBody = $("invitesBody");
    const catalog = $("rbacCatalog");
    if (!sel || !membersBody) return;
    function displayEmail(email) {
      const e = (email || "").trim();
      if (!e || e.endsWith("@getglowop.internal") || e.endsWith("@clerk.local")) return "Signed-in account";
      return e;
    }
    function displayName(name, email) {
      const n = (name || "").trim();
      if (n && n.toLowerCase() !== "partner") return n;
      const e = displayEmail(email);
      return e === "Signed-in account" ? "You" : e.split("@")[0];
    }

    if (!businessesCache.length) {
      sel.innerHTML = "";
      membersBody.innerHTML = `<p class="people-empty">Add a business first, then invite people.</p>`;
      if (invitesBody) invitesBody.innerHTML = "";
      return;
    }
    const prev = sel.value;
    sel.innerHTML = businessesCache
      .map(
        (b) =>
          `<option value="${esc(b.business_id)}">${esc(b.business_name || b.business_id)}</option>`
      )
      .join("");
    if (prev && businessesCache.some((b) => b.business_id === prev)) sel.value = prev;

    const businessId = sel.value;
    try {
      const data = await api(`/api/partner/members?businessId=${encodeURIComponent(businessId)}`);
      peopleCanManage = !!data.canManage;
      const roleEl = $("peopleMyRole");
      if (roleEl) roleEl.textContent = `Your role: ${data.myRole || "—"}`;
      membersBody.innerHTML = (data.members || [])
        .map((m) => {
          const roleSelect = peopleCanManage
            ? `<select data-role-partner="${esc(m.partnerId)}" class="role-select" aria-label="Role">
                ${["owner", "admin", "operator", "viewer"]
                  .map(
                    (r) =>
                      `<option value="${r}" ${r === m.role ? "selected" : ""}>${r}</option>`
                  )
                  .join("")}
              </select>`
            : `<span class="p-meta">${esc(m.role)}</span>`;
          const revokeBtn = peopleCanManage
            ? `<button type="button" class="btn ghost danger" data-revoke-member="${esc(
                m.partnerId
              )}">Remove</button>`
            : "";
          return `<div class="people-row">
            <span class="p-email" title="${esc(m.email || "")}">${esc(displayEmail(m.email))}</span>
            <span class="p-name">${esc(displayName(m.name, m.email))}</span>
            ${roleSelect}
            ${revokeBtn || "<span></span>"}
          </div>`;
        })
        .join("") || `<p class="people-empty">No members yet.</p>`;

      if (invitesBody) {
        invitesBody.innerHTML = (data.invitations || [])
          .map((inv) => {
            const revoke =
              peopleCanManage && inv.status === "pending"
                ? `<button type="button" class="btn ghost" data-revoke-invite="${esc(
                    inv.id
                  )}">Revoke</button>`
                : "<span></span>";
            return `<div class="people-row invite">
              <span class="p-email">${esc(inv.email)}</span>
              <span class="p-meta">${esc(inv.role)}</span>
              <span class="p-meta">${esc(inv.status)}</span>
              <span class="p-meta">${esc((inv.expiresAt || "").slice(0, 10))}</span>
              ${revoke}
            </div>`;
          })
          .join("") || `<p class="people-empty">No pending invites.</p>`;
      }

      if (catalog) {
        const cat = await api("/api/partner/rbac/catalog");
        catalog.innerHTML = (cat.permissions || [])
          .map(
            (p) =>
              `<div class="perm-item"><strong>${esc(p.permission)}</strong><span>${esc(
                (p.roles || []).join(" · ")
              )}</span></div>`
          )
          .join("") || `<p class="people-empty">No permissions listed.</p>`;
      }

      const inviteForm = $("inviteForm");
      if (inviteForm) {
        const controls = inviteForm.querySelectorAll("input, select, button");
        controls.forEach((el) => {
          el.disabled = !peopleCanManage;
        });
      }
    } catch (err) {
      membersBody.innerHTML = `<p class="people-empty">${esc(err.message || err)}</p>`;
    }
  }

  async function renderAnalyze() {
    const grid = $("analyzeGrid");
    if (!grid) return;
    if (!businessesCache.length) {
      grid.innerHTML = `<p class="people-empty">Add a business first, then open its report here.</p>`;
      return;
    }
    const calls = [
      ["repair", "Repair"],
      ["ghost", "Ghosts"],
      ["recycle", "Recycle"],
      ["refresh", "Refresh"],
      ["redeploy", "Redeploy"],
      ["keep", "Keep"],
    ];
    grid.innerHTML = businessesCache
      .map((b) => {
        const tid = encodeURIComponent(b.business_id);
        const base = `/app/?from=partner&tenant=${tid}`;
        const callLinks = calls
          .map(
            ([id, label]) =>
              `<a class="call-chip" href="${base}&view=fleet&call=${encodeURIComponent(id)}">${label}</a>`
          )
          .join("");
        return `<article class="analyze-card" data-biz="${esc(b.business_id)}">
          <div class="analyze-card-top">
            <h3>${esc(b.business_name || "Business")}</h3>
            <div class="kpis" id="an-${esc(b.business_id)}"><span>Loading…</span></div>
          </div>
          <div class="analyze-actions">
            <a class="btn lime" href="${base}&view=fleet">Fleet report</a>
            <a class="btn ghost" href="${base}&view=dashboard">Dashboard</a>
            <a class="btn ghost" href="${base}&view=settings">Settings</a>
          </div>
          <div class="analyze-calls">
            <span class="analyze-calls-label">Calls</span>
            <div class="call-chips">${callLinks}</div>
          </div>
        </article>`;
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
            <div><span class="glow-mark">Avg GLOW<sup class="tm" aria-label="trademark">™</sup></span> <strong>${s.avgGlowScore ?? "—"}</strong></div>
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
    if ($("bizCount")) $("bizCount").textContent = businessesCache.length;
    const bizSelect = $("enrollBiz");
    if (bizSelect) {
      bizSelect.innerHTML = businessesCache
        .map(
          (b) =>
            `<option value="${esc(b.business_id)}">${esc(b.business_name || b.business_id)}</option>`
        )
        .join("");
    }
    enrollKeysCache = enroll.keys || [];
    loadBizRows();
    const active = (keys.keys || []).filter((k) => !k.revoked_at);
    if ($("keyCount")) $("keyCount").textContent = active.length;
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
        const bizName =
          businessesCache.find((b) => b.business_id === k.business_id)?.business_name ||
          "Business";
        return `<tr>
          <td>${esc(k.label)}</td>
          <td>${esc(bizName)}</td>
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
    if ($("pviewPeople")?.dataset.active === "true") renderPeople();
  }

  // ---- Businesses grid ----
  let bizRows = [];
  let enrollKeysCache = [];
  let bizLayout = localStorage.getItem("glowops.bizLayout") || "table";
  const pins = new Set(JSON.parse(localStorage.getItem("glowops.bizPins") || "[]"));
  const DAY = 86400000;

  function bizStatus(b) {
    const last = b.lastCheckIn ? Date.parse(b.lastCheckIn) : 0;
    if (!b.deviceCount && !last) return { key: "none", label: "Not deployed" };
    if (last && Date.now() - last > 7 * DAY) {
      return { key: "stale", label: `Stale · quiet ${Math.floor((Date.now() - last) / DAY)} days` };
    }
    const first = b.firstCheckIn ? Date.parse(b.firstCheckIn) : last || Date.now();
    const day = Math.max(1, Math.floor((Date.now() - first) / DAY) + 1);
    if (day < 30) return { key: "collecting", label: `Collecting · day ${day} of 30` };
    return { key: "ready", label: "Report ready" };
  }

  function sinceText(iso) {
    if (!iso) return "never";
    const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000);
    if (mins < 60) return `${Math.max(1, mins)}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return `${Math.floor(mins / 1440)}d ago`;
  }

  async function loadBizRows() {
    const grid = $("bizList");
    if (!grid) return;
    bizRows = businessesCache.map((b) => ({
      businessId: b.business_id,
      businessName: b.business_name || "Business",
      deviceCount: 0,
      loading: true,
    }));
    renderBizGrid();
    try {
      const p = await api("/api/partner/portfolio");
      const byId = new Map((p.businesses || []).map((r) => [r.businessId, r]));
      bizRows = bizRows.map((r) => ({ ...r, ...(byId.get(r.businessId) || {}), loading: false }));
    } catch (_) {
      bizRows = bizRows.map((r) => ({ ...r, loading: false }));
    }
    renderBizGrid();
  }

  function visibleBizRows() {
    const q = ($("bizSearch")?.value || "").trim().toLowerCase();
    const filter = $("bizFilter")?.value || "";
    const sort = $("bizSort")?.value || "name";
    const rows = bizRows
      .map((r) => ({ ...r, status: bizStatus(r) }))
      .filter((r) => !q || r.businessName.toLowerCase().includes(q))
      .filter((r) => !filter || r.status.key === filter);
    const cmp = {
      name: (a, b) => a.businessName.localeCompare(b.businessName),
      ghosts: (a, b) => (b.ghostCount || 0) - (a.ghostCount || 0),
      glow: (a, b) => (a.avgGlowScore ?? 999) - (b.avgGlowScore ?? 999),
      devices: (a, b) => (b.deviceCount || 0) - (a.deviceCount || 0),
      recent: (a, b) => (Date.parse(b.lastCheckIn || 0) || 0) - (Date.parse(a.lastCheckIn || 0) || 0),
    }[sort];
    return rows.sort((a, b) => (pins.has(b.businessId) - pins.has(a.businessId)) || cmp(a, b));
  }

  function groupedBizRows(rows) {
    const mode = $("bizGroup")?.value || "";
    if (mode !== "status") return [{ label: "", rows }];
    const order = [
      ["none", "Not deployed"],
      ["collecting", "Collecting"],
      ["ready", "Report ready"],
      ["stale", "Stale"],
    ];
    return order
      .map(([key, label]) => ({ label, rows: rows.filter((r) => r.status.key === key) }))
      .filter((g) => g.rows.length);
  }

  function manageMenu(id, name, href) {
    return `<details class="biz-manage">
      <summary class="biz-cog" aria-label="Business settings" title="Business settings">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </summary>
      <div class="biz-manage-menu" role="menu">
        <button type="button" role="menuitem" data-biz-pin="${esc(id)}">${pins.has(id) ? "Unpin" : "Pin to top"}</button>
        <button type="button" role="menuitem" data-biz-rename="${esc(id)}" data-biz-name="${esc(name)}">Rename</button>
        <a role="menuitem" href="/partner/?view=people&tenant=${encodeURIComponent(id)}">People</a>
        <a role="menuitem" href="${href}">Open report</a>
        <button type="button" role="menuitem" class="danger" data-biz-remove="${esc(id)}" data-biz-name="${esc(name)}">Remove from console</button>
      </div>
    </details>`;
  }

  function renderBizGrid() {
    const grid = $("bizList");
    if (!grid) return;
    document.querySelectorAll("[data-bizlayout]").forEach((b) =>
      b.setAttribute("aria-pressed", b.getAttribute("data-bizlayout") === bizLayout ? "true" : "false")
    );
    if (!bizRows.length) {
      grid.className = "biz-grid";
      grid.innerHTML = `<p class="people-empty">No businesses yet. Add one above, then press Deploy.</p>`;
      if ($("bizShown")) $("bizShown").textContent = "";
      return;
    }
    const rows = visibleBizRows();
    const groups = groupedBizRows(rows);
    if ($("bizShown")) $("bizShown").textContent = `${rows.length} of ${bizRows.length}`;
    const num = (r, v) => (r.loading ? "…" : esc(v));
    const actions = (r, href) => `
      <a class="btn ghost" href="${href}">Open</a>
      <button type="button" class="btn ghost" data-print="${esc(r.businessId)}" data-biz-name="${esc(r.businessName)}">Print PDF</button>
      <button type="button" class="btn ghost" data-send="${esc(r.businessId)}" data-biz-name="${esc(r.businessName)}">Send</button>
      ${r.canDeploy === false ? "" : `<button type="button" class="btn lime" data-deploy="${esc(r.businessId)}">Deploy</button>`}`;
    if (bizLayout === "table") {
      grid.className = "biz-grid biz-grid-table table-fit";
      const body = groups
        .map((g) => {
          const head = g.label ? `<tr class="biz-group"><td colspan="7">${esc(g.label)} · ${g.rows.length}</td></tr>` : "";
          const lines = g.rows.map((r) => {
            const href = `/app/?from=partner&tenant=${encodeURIComponent(r.businessId)}&view=fleet`;
            return `<tr>
              <td class="biz-name"><b>${pins.has(r.businessId) ? "★ " : ""}${esc(r.businessName)}</b></td>
              <td><span class="biz-status s-${r.status.key}">${esc(r.status.label)}</span></td>
              <td class="num">${num(r, r.deviceCount ?? 0)}</td>
              <td class="num">${num(r, r.avgGlowScore ?? "—")}</td>
              <td class="num">${num(r, r.ghostCount ?? 0)}</td>
              <td>${r.loading ? "…" : esc(sinceText(r.lastCheckIn))}</td>
              <td class="biz-row-actions">${actions(r, href)}${manageMenu(r.businessId, r.businessName, href)}</td>
            </tr>`;
          }).join("");
          return head + lines;
        })
        .join("");
      grid.innerHTML = `<table>
        <colgroup>
          <col class="c-name" /><col class="c-status" /><col class="c-num" /><col class="c-num" /><col class="c-num" /><col class="c-when" /><col class="c-actions" />
        </colgroup>
        <thead><tr><th>Business</th><th>Status</th><th>Devices</th><th>GLOW™</th><th>Ghosts</th><th>Last check-in</th><th>Actions</th></tr></thead>
        <tbody>${body || `<tr><td colspan="7">No businesses match.</td></tr>`}</tbody></table>`;
      return;
    }
    grid.className = "biz-grid";
    grid.innerHTML = groups
      .map((g) => {
        const head = g.label ? `<h3 class="biz-group-label">${esc(g.label)} · ${g.rows.length}</h3>` : "";
        return head + g.rows
      .map((r) => {
        const href = `/app/?from=partner&tenant=${encodeURIComponent(r.businessId)}&view=fleet`;
        return `<article class="biz-card${pins.has(r.businessId) ? " pinned" : ""}">
          <header class="biz-card-head">
            <h3 title="${esc(r.businessName)}">${esc(r.businessName)}</h3>
            ${manageMenu(r.businessId, r.businessName, href)}
          </header>
          <span class="biz-status s-${r.status.key}">${r.loading ? "Loading…" : esc(r.status.label)}</span>
          <dl class="biz-card-kpis">
            <div><dt>Devices</dt><dd>${num(r, r.deviceCount ?? 0)}</dd></div>
            <div><dt>Avg GLOW™</dt><dd>${num(r, r.avgGlowScore ?? "—")}</dd></div>
            <div><dt>Ghosts</dt><dd>${num(r, r.ghostCount ?? 0)}</dd></div>
            <div><dt>Last check-in</dt><dd>${r.loading ? "…" : esc(sinceText(r.lastCheckIn))}</dd></div>
          </dl>
          <div class="biz-card-actions">${actions(r, href)}</div>
        </article>`;
      }).join("");
      })
      .join("") || `<p class="people-empty">No businesses match.</p>`;
  }

  const savedGroup = localStorage.getItem("glowops.bizGroup");
  if ($("bizGroup") && savedGroup) $("bizGroup").value = savedGroup;
  ["bizSearch", "bizFilter", "bizSort", "bizGroup"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener(id === "bizSearch" ? "input" : "change", renderBizGrid);
  });
  document.querySelectorAll("[data-bizlayout]").forEach((btn) =>
    btn.addEventListener("click", () => {
      bizLayout = btn.getAttribute("data-bizlayout");
      localStorage.setItem("glowops.bizLayout", bizLayout);
      renderBizGrid();
    })
  );
  if ($("bizGroup")) {
    $("bizGroup").addEventListener("change", () => {
      localStorage.setItem("glowops.bizGroup", $("bizGroup").value);
      renderBizGrid();
    });
  }

  // ---- Deploy dialog ----
  let deployBizId = "";

  async function apiDownload(path, body) {
    await refreshClerkToken();
    const headers = { "Content-Type": "application/json" };
    if (clerkToken) headers.Authorization = `Bearer ${clerkToken}`;
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const disp = res.headers.get("Content-Disposition") || "";
    const name = (disp.match(/filename="([^"]+)"/) || [])[1] || "glowops-package";
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    return { name, expiresAt: res.headers.get("X-GlowOps-Expires") || "" };
  }

  function renderDeployKeys() {
    const box = $("deployKeys");
    if (!box) return;
    const keys = enrollKeysCache.filter((k) => k.business_id === deployBizId).slice(0, 12);
    box.innerHTML =
      keys
        .map(
          (k) => `<div class="people-row">
            <span class="p-email">${esc(k.label)}</span>
            <span class="p-meta"><code>${esc(k.key_prefix)}…</code></span>
            <span class="p-meta">${esc(k.status)} · ${esc((k.expires_at || "").slice(0, 10))} · ${esc(k.use_count ?? 0)} joins</span>
            ${
              k.status === "active"
                ? `<button type="button" class="btn ghost danger" data-revoke-enroll="${esc(k.id)}">Revoke</button>`
                : "<span></span>"
            }
          </div>`
        )
        .join("") || `<p class="people-empty">No keys yet. Each download makes one.</p>`;
  }

  async function renderIntuneState() {
    const pill = $("intuneState");
    const lede = $("intuneLede");
    const connectRow = $("intuneConnectRow");
    const pushRow = $("intunePushRow");
    connectRow.hidden = true;
    pushRow.hidden = true;
    pill.textContent = "Checking…";
    pill.className = "deploy-pill";
    try {
      const s = await api(`/api/partner/intune/status?businessId=${encodeURIComponent(deployBizId)}`);
      if (!s.configured) {
        pill.textContent = "Coming to this host";
        lede.textContent =
          "Direct push needs the GlowOps Microsoft app on this host. Until then, download the .intunewin below and upload it in Intune.";
        return;
      }
      if (s.connected) {
        pill.textContent = "Connected";
        pill.classList.add("on");
        pushRow.hidden = false;
        lede.textContent =
          "Uploads the GlowOps Win32 app to this customer's Intune with install, uninstall, and detection already set. Pushing again swaps in a fresh key for new devices.";
      } else {
        pill.textContent = "Not connected";
        connectRow.hidden = !s.canConnect;
        lede.textContent = s.canConnect
          ? "Connect this business to its Microsoft 365 once. After that, Push to Intune is one click."
          : "An admin or owner on this business connects Intune once. You can still download the package below.";
      }
    } catch (err) {
      pill.textContent = "Unavailable";
      lede.textContent = String(err.message || err);
    }
  }

  function openDeploy(businessId) {
    const dlg = $("deployDialog");
    if (!dlg) return;
    deployBizId = businessId;
    const row = bizRows.find((r) => r.businessId === businessId);
    $("deployTitle").textContent =
      row?.businessName || businessesCache.find((b) => b.business_id === businessId)?.business_name || "Business";
    $("deployStatus").textContent = "";
    $("intuneResult").textContent = "";
    renderDeployKeys();
    renderIntuneState();
    if (!dlg.open) dlg.showModal();
  }

  async function reloadKeys() {
    const enroll = await api("/api/partner/enrollment-keys");
    enrollKeysCache = enroll.keys || [];
    renderDeployKeys();
  }

  const deployDialog = $("deployDialog");
  if (deployDialog) {
    deployDialog.addEventListener("click", async (e) => {
      const kitBtn = e.target.closest("[data-kit]");
      if (kitBtn) {
        const st = $("deployStatus");
        kitBtn.disabled = true;
        st.textContent = "Building package…";
        try {
          const got = await apiDownload("/api/partner/deploy-kit", {
            businessId: deployBizId,
            channel: kitBtn.getAttribute("data-kit"),
            ttlHours: Number($("deployTtl").value || 720),
          });
          st.textContent = `Downloaded ${got.name}. Key works until ${got.expiresAt.slice(0, 10)}. It holds a join password, so don't email or post it.`;
          await reloadKeys();
        } catch (err) {
          st.textContent = String(err.message || err);
        } finally {
          kitBtn.disabled = false;
        }
        return;
      }
      const revokeBtn = e.target.closest("[data-revoke-enroll]");
      if (revokeBtn) {
        e.stopPropagation();
        if (!confirm("Revoke this key? Devices that joined with it stop reporting too.")) return;
        try {
          await api(`/api/partner/enrollment-keys/${encodeURIComponent(revokeBtn.getAttribute("data-revoke-enroll"))}/revoke`, {
            method: "POST",
            body: "{}",
          });
          await reloadKeys();
        } catch (err) {
          alert(String(err.message || err));
        }
      }
    });
    $("intuneAssign").addEventListener("change", () => {
      $("intuneGroup").hidden = $("intuneAssign").value !== "group";
    });
    $("intuneConnect").addEventListener("click", async () => {
      try {
        const r = await api("/api/partner/intune/connect", {
          method: "POST",
          body: JSON.stringify({ businessId: deployBizId }),
        });
        location.href = r.consentUrl;
      } catch (err) {
        $("intuneResult").textContent = String(err.message || err);
      }
    });
    $("intunePush").addEventListener("click", async () => {
      const btn = $("intunePush");
      const out = $("intuneResult");
      btn.disabled = true;
      out.textContent = "Uploading to Intune. This takes about a minute…";
      try {
        const r = await api("/api/partner/intune/deploy", {
          method: "POST",
          body: JSON.stringify({
            businessId: deployBizId,
            assign: $("intuneAssign").value,
            groupId: ($("intuneGroup").value || "").trim(),
          }),
        });
        out.innerHTML = `${r.created ? "Created" : "Updated"} the GlowOps app${
          r.assigned ? `, assigned to ${esc(r.assigned)}` : ""
        }. Key works until ${esc((r.expiresAt || "").slice(0, 10))}. <a href="${esc(r.portalUrl)}" target="_blank" rel="noopener">Open in Intune</a>`;
        await reloadKeys();
      } catch (err) {
        out.textContent = String(err.message || err);
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function finishIntuneConsent() {
    const params = new URLSearchParams(location.search);
    const state = params.get("intuneState");
    const failed = params.get("intune") === "failed";
    if (!state && !failed) return;
    const clean = new URL(location.href);
    ["intuneState", "intuneDirectory", "intune"].forEach((k) => clean.searchParams.delete(k));
    history.replaceState(null, "", clean.pathname + clean.search);
    if (failed) {
      alert("Microsoft consent was not granted. Try Connect Intune again with a Global Admin.");
      return;
    }
    try {
      const r = await api("/api/partner/intune/complete", {
        method: "POST",
        body: JSON.stringify({ state, directoryId: params.get("intuneDirectory") || "" }),
      });
      setPView("biz");
      openDeploy(r.businessId);
    } catch (err) {
      alert(String(err.message || err));
    }
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
        showDash(me.partner, me.roles || []);
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
        if (window.__glowClerk) {
          await window.__glowClerk.signOut({ redirectUrl: "/partner/" });
          return;
        }
        await api("/api/partner/logout", { method: "POST", body: "{}" });
      } catch (_) {}
      clerkToken = null;
      showLogin();
      if (clerkEnabled) mountClerkSignIn();
    });
  }

  const addBizForm = $("addBizForm");
  if (addBizForm) {
    addBizForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const st = $("addBizStatus");
      const name = ($("newBizName")?.value || "").trim();
      if (!name) {
        if (st) st.textContent = "Name required";
        return;
      }
      if (st) st.textContent = "Adding…";
      try {
        const created = await api("/api/partner/businesses", {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        if (st) st.textContent = `Added ${created.business?.business_name || name}`;
        if ($("newBizName")) $("newBizName").value = "";
        await refresh();
        renderHome();
      } catch (err) {
        if (st) st.textContent = String(err.message || err);
      }
    });
  }

  const bizList = $("bizList");
  if (bizList) {
    async function businessDoc(id, name) {
      const [summary, devices] = await Promise.all([
        api(`/api/summary?tenant=${encodeURIComponent(id)}`),
        api(`/api/devices?tenant=${encodeURIComponent(id)}`),
      ]);
      return {
        title: name || summary.businessName || "Business",
        sections: [{ name: name || summary.businessName || "Business", summary, devices: devices.devices || [] }],
      };
    }

    async function portfolioDoc() {
      const portfolio = await api("/api/partner/portfolio");
      const sections = await Promise.all(
        (portfolio.businesses || []).map(async (b) => {
          const devices = await api(`/api/devices?tenant=${encodeURIComponent(b.businessId)}`);
          return {
            name: b.businessName || "Business",
            summary: {
              deviceCount: b.deviceCount,
              avgGlowScore: b.avgGlowScore,
              ghostCount: b.ghostCount,
              repairBeforeReplaceCount: b.repairCount,
            },
            devices: devices.devices || [],
          };
        })
      );
      return {
        title: "All businesses",
        kpis: {
          devices: portfolio.deviceCount,
          glow: portfolio.avgGlowScore,
          ghosts: portfolio.ghostCount,
          repair: portfolio.repairCount,
          kg: portfolio.manufacturingKgOnBooks,
        },
        sections,
      };
    }

    const printPortfolio = $("printPortfolio");
    const sendPortfolio = $("sendPortfolio");
    if (printPortfolio) {
      printPortfolio.addEventListener("click", async () => {
        try { GlowReport.openPrint(await portfolioDoc()); } catch (err) { alert(String(err.message || err)); }
      });
    }
    if (sendPortfolio) {
      sendPortfolio.addEventListener("click", async () => {
        try { await GlowReport.send(await portfolioDoc()); } catch (err) { alert(String(err.message || err)); }
      });
    }

    bizList.addEventListener("click", async (e) => {
      const reportBtn = e.target.closest("[data-print], [data-send]");
      if (reportBtn) {
        const id = reportBtn.getAttribute("data-print") || reportBtn.getAttribute("data-send");
        const name = reportBtn.getAttribute("data-biz-name");
        try {
          const doc = await businessDoc(id, name);
          if (reportBtn.hasAttribute("data-print")) GlowReport.openPrint(doc);
          else await GlowReport.send(doc);
        } catch (err) {
          alert(String(err.message || err));
        }
        return;
      }
      const deployBtn = e.target.closest("[data-deploy]");
      if (deployBtn) {
        openDeploy(deployBtn.getAttribute("data-deploy"));
        return;
      }
      const pinBtn = e.target.closest("[data-biz-pin]");
      if (pinBtn) {
        const id = pinBtn.getAttribute("data-biz-pin");
        if (pins.has(id)) pins.delete(id);
        else pins.add(id);
        localStorage.setItem("glowops.bizPins", JSON.stringify([...pins]));
        renderBizGrid();
        return;
      }
      const renameBtn = e.target.closest("[data-biz-rename]");
      if (renameBtn) {
        e.preventDefault();
        const businessId = renameBtn.getAttribute("data-biz-rename");
        const current = renameBtn.getAttribute("data-biz-name") || "";
        const next = window.prompt("New business name", current);
        if (next == null) return;
        const name = next.trim();
        if (!name || !businessId) return;
        try {
          await api("/api/business", {
            method: "POST",
            body: JSON.stringify({ tenantId: businessId, businessId, name }),
          });
          await refresh();
        } catch (err) {
          alert(String(err.message || err));
        }
        return;
      }
      const removeBtn = e.target.closest("[data-biz-remove]");
      if (removeBtn) {
        e.preventDefault();
        const businessId = removeBtn.getAttribute("data-biz-remove");
        const label = removeBtn.getAttribute("data-biz-name") || "this business";
        if (
          !businessId ||
          !confirm(
            `Remove “${label}” from your partner console?\n\nFleet data stays on the platform; you lose access until invited again.`
          )
        ) {
          return;
        }
        try {
          await api("/api/partner/businesses/unbind", {
            method: "POST",
            body: JSON.stringify({ businessId }),
          });
          await refresh();
          renderHome();
        } catch (err) {
          alert(String(err.message || err));
        }
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
        setEnrollDashUrl(minted.dashboardUrl || dashboardUrl);
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

  async function copyText(value, btn) {
    const text = (value || "").trim();
    if (!text || !btn) return;
    const prev = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch (_) {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => {
      btn.textContent = prev;
    }, 1400);
  }

  const copyEnroll = $("copyEnroll");
  if (copyEnroll) {
    copyEnroll.addEventListener("click", async () => {
      const text = [
        `Dashboard URL: ${$("freshDashUrl")?.textContent || dashboardUrl}`,
        `Join Key: ${$("freshJoinKey").textContent}`,
        `Join Password: ${$("freshJoinPass").textContent}`,
      ].join("\n");
      await copyText(text, copyEnroll);
    });
  }
  document.querySelectorAll(".secret-copy[data-copy-target]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-copy-target");
      await copyText($(id)?.textContent || "", btn);
    });
  });

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
  setEnrollDashUrl(DEFAULT_DASH_URL);
  fetch("/api/config/public")
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (cfg?.publicUrl) setEnrollDashUrl(cfg.publicUrl);
    })
    .catch(() => {});
  initClerk().then((usedClerk) => {
    if (usedClerk) return;
    api("/api/partner/me")
      .then((data) => showDash(data.partner, data.roles || []))
      .catch(() => showLogin());
  });

  const peopleBiz = $("peopleBiz");
  if (peopleBiz) {
    peopleBiz.addEventListener("change", () => renderPeople());
  }

  const inviteForm = $("inviteForm");
  if (inviteForm) {
    inviteForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const st = $("inviteStatus");
      const businessId = $("peopleBiz")?.value;
      const email = ($("inviteEmail")?.value || "").trim();
      const role = $("inviteRole")?.value || "viewer";
      if (!businessId || !email) {
        if (st) st.textContent = "Business and email required";
        return;
      }
      if (st) st.textContent = "Creating invite…";
      try {
        const invited = await api("/api/partner/invitations", {
          method: "POST",
          body: JSON.stringify({ businessId, email, role }),
        });
        const link = `${location.origin}${invited.acceptPath}`;
        if (st) st.textContent = `Invite created for ${invited.email} (${invited.role})`;
        const box = $("freshInvite");
        const code = $("freshInviteLink");
        if (box && code) {
          box.hidden = false;
          code.textContent = link;
        }
        if ($("inviteEmail")) $("inviteEmail").value = "";
        await renderPeople();
      } catch (err) {
        if (st) st.textContent = String(err.message || err);
      }
    });
  }

  const copyInvite = $("copyInvite");
  if (copyInvite) {
    copyInvite.addEventListener("click", async () => {
      const v = $("freshInviteLink")?.textContent || "";
      try {
        await navigator.clipboard.writeText(v);
        copyInvite.textContent = "Copied";
      } catch (_) {}
    });
  }

  document.addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-role-partner]");
    if (!sel) return;
    const businessId = $("peopleBiz")?.value;
    const partnerId = sel.getAttribute("data-role-partner");
    const role = sel.value;
    try {
      await api("/api/partner/members/role", {
        method: "POST",
        body: JSON.stringify({ businessId, partnerId, role }),
      });
      await renderPeople();
    } catch (err) {
      alert(String(err.message || err));
      await renderPeople();
    }
  });

  document.addEventListener("click", async (e) => {
    const rm = e.target.closest("[data-revoke-member]");
    if (rm) {
      const businessId = $("peopleBiz")?.value;
      const partnerId = rm.getAttribute("data-revoke-member");
      if (!confirm("Remove this member from the business?")) return;
      try {
        await api("/api/partner/members/revoke", {
          method: "POST",
          body: JSON.stringify({ businessId, partnerId }),
        });
        await renderPeople();
      } catch (err) {
        alert(String(err.message || err));
      }
      return;
    }
    const ri = e.target.closest("[data-revoke-invite]");
    if (ri) {
      const businessId = $("peopleBiz")?.value;
      const id = ri.getAttribute("data-revoke-invite");
      try {
        await api(`/api/partner/invitations/${encodeURIComponent(id)}/revoke`, {
          method: "POST",
          body: JSON.stringify({ businessId }),
        });
        await renderPeople();
      } catch (err) {
        alert(String(err.message || err));
      }
    }
  });
})();
