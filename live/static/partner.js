(() => {
  const $ = (id) => document.getElementById(id);
  const loginView = $("loginView");
  const dashView = $("dashView");

  function mcpBase() {
    return `${window.location.origin}/mcp`;
  }

  function renderConfig(apiKeyPlaceholder) {
    const key = apiKeyPlaceholder || "gow_mcp_YOUR_KEY";
    $("mcpConfig").textContent = JSON.stringify(
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
    $("mcpUrl").textContent = mcpBase().replace(/^https?:\/\//, "");
  }

  function setPView(name) {
    const map = {
      enroll: "pviewEnroll",
      keys: "pviewKeys",
      biz: "pviewBiz",
      connect: "pviewConnect",
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
    loginView.hidden = true;
    dashView.hidden = false;
    $("logoutBtn").hidden = false;
    $("partnerViews").hidden = false;
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
    loginView.hidden = false;
    dashView.hidden = true;
    $("logoutBtn").hidden = true;
    $("partnerViews").hidden = true;
    $("partnerHello").hidden = true;
  }

  async function refresh() {
    const [biz, keys, enroll] = await Promise.all([
      api("/api/partner/businesses"),
      api("/api/partner/mcp-keys"),
      api("/api/partner/enrollment-keys"),
    ]);
    $("bizCount").textContent = (biz.businesses || []).length;
    const bizSelect = $("enrollBiz");
    if (bizSelect) {
      bizSelect.innerHTML = (biz.businesses || [])
        .map(
          (b) =>
            `<option value="${esc(b.business_id)}">${esc(b.business_name || b.business_id)}</option>`
        )
        .join("");
    }
    $("bizList").innerHTML = (biz.businesses || [])
      .map(
        (b) =>
          `<li><span><b>${esc(b.business_name || b.business_id)}</b><div class="hint">${esc(
            b.business_id
          )}</div></span><a class="btn ghost" href="/app/">Open</a></li>`
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

  // Start on login; upgrade to dash only after a valid session.
  showLogin();
  api("/api/partner/me")
    .then((data) => showDash(data.partner))
    .catch(() => showLogin());
})();
