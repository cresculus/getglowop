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
      enroll: "pviewEnroll",
      biz: "pviewBiz",
      analyze: "pviewAnalyze",
      settings: "pviewSettings",
    };
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
    if (name === "analyze") renderAnalyze();
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
    return data;
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
    setPView("enroll");
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

  async function renderAnalyze() {
    const grid = $("analyzeGrid");
    if (!grid) return;
    if (!businessesCache.length) {
      grid.innerHTML = `<p class="view-lede">No businesses assigned yet.</p>`;
      return;
    }
    grid.innerHTML = businessesCache
      .map(
        (b) => `<article class="analyze-card" data-biz="${esc(b.business_id)}">
        <h3>${esc(b.business_name || b.business_id)}</h3>
        <div class="meta-line">${esc(b.business_id)}</div>
        <div class="kpis" id="an-${esc(b.business_id)}"><span>Loading…</span></div>
        <a class="btn lime" href="/app/?from=partner&tenant=${encodeURIComponent(b.business_id)}&view=fleet">Open report</a>
      </article>`
      )
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
      .map(
        (b) =>
          `<li><span><b>${esc(b.business_name || b.business_id)}</b><div class="hint">${esc(
            b.business_id
          )}</div></span><a class="btn lime" href="/app/?from=partner&tenant=${encodeURIComponent(
            b.business_id
          )}&view=fleet">Open report</a></li>`
      )
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
        await api("/api/partner/logout", { method: "POST", body: "{}" });
      } catch (_) {}
      showLogin();
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
  api("/api/partner/me")
    .then((data) => showDash(data.partner))
    .catch(() => showLogin());
})();
