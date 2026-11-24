(() => {
  const $ = (id) => document.getElementById(id);
  const CALLS = ["all", "keep", "repair", "redeploy", "refresh", "recycle", "ghost"];

  let devices = [];
  let summary = null;
  let activeCall = "all";

  const tenantEl = $("tenant");
  const statusEl = $("status");
  const tbody = $("tbody");
  const callsEl = $("calls");
  const emptyEl = $("empty");
  const searchEl = $("search");

  function tenant() {
    return (tenantEl.value || "demo").trim() || "demo";
  }

  function glowClass(n) {
    if (n == null) return "mid";
    if (n < 40) return "low";
    if (n < 60) return "mid";
    return "high";
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setMeta(s) {
    $("kpi-count").textContent = s.deviceCount ?? 0;
    $("kpi-glow").textContent = s.avgGlowScore ?? "—";
    $("kpi-ghost").textContent = s.ghostCount ?? 0;
    $("kpi-repair").textContent = s.repairBeforeReplaceCount ?? 0;
    $("kpi-kg").textContent = s.manufacturingKgOnBooks ?? 0;
    $("kpi-avoid").textContent = s.avoidablePurchasesIfExtended ?? 0;
  }

  function renderFilters() {
    const by = (summary && summary.byCall) || {};
    const total = summary ? summary.deviceCount || 0 : devices.length;
    callsEl.innerHTML = CALLS.map((k) => {
      const count = k === "all" ? total : by[k] || 0;
      const pressed = activeCall === k ? "true" : "false";
      const label = k === "all" ? "All" : k;
      return `<button type="button" class="chip" data-call="${k}" aria-pressed="${pressed}">${label}<b>${count}</b></button>`;
    }).join("");
  }

  function filtered() {
    const q = (searchEl.value || "").trim().toLowerCase();
    return devices.filter((d) => {
      if (activeCall !== "all" && (d.call_label || "keep") !== activeCall) return false;
      if (!q) return true;
      const blob = [d.device_name, d.serial_number, d.manufacturer, d.model, d.user_upn, d.rationale]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return blob.includes(q);
    });
  }

  function renderDevices() {
    const rows = filtered();
    emptyEl.hidden = rows.length > 0;
    tbody.innerHTML = rows
      .map((d) => {
        const call = d.call_label || "keep";
        const glow = d.glow_score;
        const model = [d.manufacturer, d.model].filter(Boolean).join(" ");
        return `<tr>
          <td class="device">
            <strong>${esc(d.device_name || "—")}</strong>
            <div class="serial">${esc(d.serial_number || "no serial")}</div>
            <div class="model">${esc(model || "—")}</div>
          </td>
          <td><span class="pill ${call}">${call}</span></td>
          <td class="glow ${glowClass(glow)}">${glow ?? "—"}</td>
          <td>${d.age_years != null ? d.age_years + "y" : "—"}</td>
          <td>${d.check_in_days != null ? d.check_in_days + "d" : "—"}</td>
          <td>${esc(d.compliance_state || "—")}</td>
          <td class="why">${esc(d.rationale || "")}</td>
        </tr>`;
      })
      .join("");
  }

  async function load() {
    const t = tenant();
    $("exportCsv").href = `/api/export.csv?tenant=${encodeURIComponent(t)}`;
    statusEl.textContent = "Loading fleet…";
    try {
      const [sumRes, devRes] = await Promise.all([
        fetch(`/api/summary?tenant=${encodeURIComponent(t)}`),
        fetch(`/api/devices?tenant=${encodeURIComponent(t)}`),
      ]);
      if (!sumRes.ok || !devRes.ok) throw new Error("API error");
      summary = await sumRes.json();
      const payload = await devRes.json();
      devices = payload.devices || [];
      setMeta(summary);
      renderFilters();
      renderDevices();
      statusEl.textContent = `${summary.deviceCount || 0} devices scored for business “${t}”.`;
    } catch (err) {
      statusEl.textContent = "Could not load fleet — is the server running?";
      console.error(err);
    }
  }

  callsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-call]");
    if (!btn) return;
    activeCall = btn.getAttribute("data-call");
    renderFilters();
    renderDevices();
  });

  searchEl.addEventListener("input", renderDevices);
  $("refresh").addEventListener("click", load);
  tenantEl.addEventListener("change", load);
  tenantEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") load();
  });

  $("toggleIngest").addEventListener("click", () => {
    const panel = $("ingestPanel");
    panel.hidden = !panel.hidden;
  });

  $("ingestBtn").addEventListener("click", async () => {
    const raw = $("ingestJson").value.trim();
    const st = $("ingestStatus");
    if (!raw) {
      st.textContent = "Paste JSON first";
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      st.textContent = "Invalid JSON";
      return;
    }
    if (Array.isArray(payload)) payload = { value: payload };
    payload.tenantId = tenant();
    payload.source = "dashboard-paste";
    st.textContent = "Ingesting…";
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "ingest failed");
      st.textContent = `Ingested ${data.ingested}`;
      load();
    } catch (err) {
      st.textContent = String(err.message || err);
    }
  });

  load();
})();
