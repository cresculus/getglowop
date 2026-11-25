(() => {
  const $ = (id) => document.getElementById(id);
  const loginView = $("loginView");
  const dashView = $("dashView");
  let businessesCache = [];

  function primaryTenant() {
    return businessesCache[0]?.business_id || "";
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
      people: "pviewPeople",
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
    if (name === "people") renderPeople();
  }

  let clerkToken = null;
  let clerkEnabled = false;
  let meRoles = [];
  let peopleCanManage = false;

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

  function mountClerkSignIn() {
    // OAuth (Google/Microsoft) is more reliable on the dedicated path page
    location.replace((window.GlowClerkPartner && GlowClerkPartner.SIGN_IN) || "/partner/sign-in");
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
    document.body.classList.add("is-authed");
    loginView.hidden = true;
    dashView.hidden = false;
    const homeBtn = $("homeBtn");
    if (homeBtn) homeBtn.hidden = false;
    $("partnerHello").hidden = false;
    $("partnerHello").textContent = me.email || me.name || "";
    const chip = $("partnerRoleChip");
    if (chip) {
      const primary = meRoles[0];
      if (primary) {
        chip.hidden = false;
        chip.textContent = `${primary.role} · ${primary.businessName || "Business"}`;
      } else {
        chip.hidden = true;
      }
    }
    const ub = $("partnerUserButton");
    if (window.__glowClerk && window.GlowClerkPartner && ub) {
      GlowClerkPartner.mountUserButton(window.__glowClerk, ub);
      $("logoutBtn").hidden = true;
    } else {
      if (ub) ub.hidden = true;
      $("logoutBtn").hidden = false;
    }
    renderConfig();
    const want = new URLSearchParams(location.search).get("view");
    setPView(want === "people" ? "people" : "home");
    refresh().catch((err) => {
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
    const homeBtn = $("homeBtn");
    if (homeBtn) homeBtn.hidden = true;
    $("partnerHello").hidden = true;
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
                <strong>${esc(b.businessName || "Business")}</strong>
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

  async function renderPeople() {
    const sel = $("peopleBiz");
    const membersBody = $("membersBody");
    const invitesBody = $("invitesBody");
    const catalog = $("rbacCatalog");
    if (!sel || !membersBody) return;
    if (!businessesCache.length) {
      sel.innerHTML = "";
      membersBody.innerHTML = `<tr><td colspan="4">Add a business first, then invite people.</td></tr>`;
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
      const chip = $("partnerRoleChip");
      if (chip && data.myRole) {
        const biz = businessesCache.find((b) => b.business_id === businessId);
        chip.hidden = false;
        chip.textContent = `${data.myRole} · ${biz?.business_name || "Business"}`;
      }
      membersBody.innerHTML = (data.members || [])
        .map((m) => {
          const roleSelect = peopleCanManage
            ? `<select data-role-partner="${esc(m.partnerId)}" class="role-select">
                ${["owner", "admin", "operator", "viewer"]
                  .map(
                    (r) =>
                      `<option value="${r}" ${r === m.role ? "selected" : ""}>${r}</option>`
                  )
                  .join("")}
              </select>`
            : esc(m.role);
          const revokeBtn =
            peopleCanManage
              ? `<button type="button" class="btn ghost danger" data-revoke-member="${esc(
                  m.partnerId
                )}">Remove</button>`
              : "";
          return `<tr>
            <td>${esc(m.email)}</td>
            <td>${esc(m.name)}</td>
            <td>${roleSelect}</td>
            <td>${revokeBtn}</td>
          </tr>`;
        })
        .join("") || `<tr><td colspan="4">No members yet.</td></tr>`;

      if (invitesBody) {
        invitesBody.innerHTML = (data.invitations || [])
          .map((inv) => {
            const revoke =
              peopleCanManage && inv.status === "pending"
                ? `<button type="button" class="btn ghost" data-revoke-invite="${esc(
                    inv.id
                  )}">Revoke</button>`
                : "";
            return `<tr>
              <td>${esc(inv.email)}</td>
              <td>${esc(inv.role)}</td>
              <td>${esc(inv.status)}</td>
              <td>${esc((inv.expiresAt || "").slice(0, 16))}</td>
              <td>${revoke}</td>
            </tr>`;
          })
          .join("") || `<tr><td colspan="5">No invites.</td></tr>`;
      }

      if (catalog) {
        const cat = await api("/api/partner/rbac/catalog");
        catalog.textContent = (cat.permissions || [])
          .map((p) => `${p.permission}: ${(p.roles || []).join(", ")}`)
          .join("\n");
      }

      const inviteForm = $("inviteForm");
      if (inviteForm) {
        const controls = inviteForm.querySelectorAll("input, select, button");
        controls.forEach((el) => {
          el.disabled = !peopleCanManage;
        });
      }
    } catch (err) {
      membersBody.innerHTML = `<tr><td colspan="4">${esc(err.message || err)}</td></tr>`;
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
        <h3>${esc(b.business_name || "Business")}</h3>
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
            <span><b>${esc(b.business_name || "Business")}</b></span>
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
