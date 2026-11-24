(() => {
  const $ = (id) => document.getElementById(id);
  const tenantEl = $("tenant");
  const statusEl = $("status");
  const tbody = $("tbody");
  const callsEl = $("calls");

  function tenant() {
    return (tenantEl.value || "demo").trim() || "demo";
  }

  function glowClass(n) {
    if (n == null) return "mid";
    if (n < 40) return "low";
    if (n < 60) return "mid";
    return "high";
  }

  function setKpis(s) {
    $("kpi-count").textContent = s.deviceCount ?? 0;
    $("kpi-glow").textContent = s.avgGlowScore ?? "—";
    $("kpi-ghost").textContent = s.ghostCount ?? 0;
    $("kpi-repair").textContent = s.repairBeforeReplaceCount ?? 0;
    $("kpi-kg").textContent = s.manufacturingKgOnBooks ?? 0;
    $("kpi-avoid").textContent = s.avoidablePurchasesIfExtended ?? 0;
    const by = s.byCall || {};
    callsEl.innerHTML = ["keep", "repair", "redeploy", "refresh", "recycle", "ghost"]
      .map((k) => `<span class="chip">${k}<b>${by[k] || 0}</b></span>`)
      .join("");
  }

  function renderDevices(devices) {
    tbody.innerHTML = devices
      .map((d) => {
        const call = d.call_label || "keep";
        const glow = d.glow_score;
        return `<tr>
          <td><strong>${esc(d.device_name || "—")}</strong><div class="muted">${esc(d.serial_number || "")}</div></td>
          <td>${esc([d.manufacturer, d.model].filter(Boolean).join(" ") || "—")}</td>
          <td><span class="pill ${call}">${call}</span></td>
          <td class="glow ${glowClass(glow)}">${glow ?? "—"}</td>
          <td>${d.age_years != null ? d.age_years + "y" : "—"}</td>
          <td>${d.check_in_days != null ? d.check_in_days + "d" : "—"}</td>
          <td>${esc(d.compliance_state || "—")}</td>
          <td class="rationale">${esc(d.rationale || "")}</td>
        </tr>`;
      })
      .join("");
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function load() {
    const t = tenant();
    $("exportCsv").href = `/api/export.csv?tenant=${encodeURIComponent(t)}`;
    statusEl.textContent = "Loading…";
    try {
      const [sumRes, devRes] = await Promise.all([
        fetch(`/api/summary?tenant=${encodeURIComponent(t)}`),
        fetch(`/api/devices?tenant=${encodeURIComponent(t)}`),
      ]);
      if (!sumRes.ok || !devRes.ok) throw new Error("API error");
      const summary = await sumRes.json();
      const devices = await devRes.json();
      setKpis(summary);
      renderDevices(devices.devices || []);
      statusEl.textContent = `${devices.count || 0} devices · tenant ${t}`;
    } catch (err) {
      statusEl.textContent = "Failed to load — is the server running?";
      console.error(err);
    }
  }

  $("refresh").addEventListener("click", load);
  tenantEl.addEventListener("change", load);
  tenantEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") load();
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
