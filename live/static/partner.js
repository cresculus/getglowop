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
    const map = { keys: "pviewKeys", biz: "pviewBiz", connect: "pviewConnect" };
    Object.entries(map).forEach(([key, id]) => {
      const el = $(id);
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
    loginView.hidden = true;
    dashView.hidden = false;
    $("logoutBtn").hidden = false;
    $("partnerViews").hidden = false;
    $("partnerHello").hidden = false;
    $("partnerHello").textContent = me.email;
    renderConfig();
    setPView("keys");
    refresh();
  }

  function showLogin() {
    loginView.hidden = false;
    dashView.hidden = true;
    $("logoutBtn").hidden = true;
    $("partnerViews").hidden = true;
    $("partnerHello").hidden = true;
  }

  async function refresh() {
    const [biz, keys] = await Promise.all([api("/api/partner/businesses"), api("/api/partner/mcp-keys")]);
    $("bizCount").textContent = (biz.businesses || []).length;
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

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("loginErr").textContent = "";
    try {
      const me = await api("/api/partner/login", {
        method: "POST",
        body: JSON.stringify({ email: $("email").value, password: $("password").value }),
      });
      showDash(me.partner);
    } catch (err) {
      $("loginErr").textContent = String(err.message || err);
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    try {
      await api("/api/partner/logout", { method: "POST", body: "{}" });
    } catch (_) {}
    showLogin();
  });

  $("mintForm").addEventListener("submit", async (e) => {
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

  $("copyKey").addEventListener("click", async () => {
    const v = $("freshKeyValue").textContent;
    try {
      await navigator.clipboard.writeText(v);
      $("copyKey").textContent = "Copied";
    } catch (_) {
      $("copyKey").textContent = "Copy";
    }
  });

  $("keysBody").addEventListener("click", async (e) => {
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

  api("/api/partner/me")
    .then((data) => showDash(data.partner))
    .catch(() => showLogin());
})();
