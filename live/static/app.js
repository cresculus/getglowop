(() => {
  const $ = (id) => document.getElementById(id);
  const CALLS = ["all", "keep", "repair", "redeploy", "refresh", "recycle", "ghost"];
  const VIEWS = ["fleet", "dashboard", "properties", "ingest"];

  let devices = [];
  let summary = null;
  let activeCall = "all";
  let selectedId = null;
  let page = 0;
  let pageSize = 12;
  let currentView = "fleet";
  let propertiesDevice = null;

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

  function val(v, fallback = "—") {
    if (v == null || v === "") return fallback;
    return String(v);
  }

  function findDevice(id) {
    return devices.find((d) => String(d.id) === String(id)) || null;
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
      return `<button type="button" class="chip" data-call="${k}" aria-pressed="${pressed}"><span>${label}</span><b>${count}</b></button>`;
    }).join("");
  }

  function filtered() {
    const q = (searchEl.value || "").trim().toLowerCase();
    return devices.filter((d) => {
      const call = String(d.call_label || d.call || "keep").toLowerCase();
      if (activeCall !== "all" && call !== activeCall) return false;
      if (!q) return true;
      const blob = [d.device_name, d.serial_number, d.manufacturer, d.model, d.user_upn, d.rationale]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return blob.includes(q);
    });
  }

  function calcPageSize() {
    const fit = document.querySelector(".table-fit");
    if (!fit) return 20;
    const head = fit.querySelector("thead");
    const headH = head ? head.getBoundingClientRect().height : 28;
    const avail = Math.max(160, fit.clientHeight - headH - 8);
    return Math.max(6, Math.floor(avail / 32));
  }

  function showDetail(d) {
    if (!d) {
      $("detailEmpty").hidden = false;
      $("detailBody").hidden = true;
      return;
    }
    $("detailEmpty").hidden = true;
    $("detailBody").hidden = false;
    $("d-name").innerHTML = `<button type="button" class="device-link" data-props="${esc(
      d.id
    )}" title="Open properties">${esc(d.device_name || "—")}</button>`;
    $("d-serial").textContent = d.serial_number || "no serial";
    $("d-model").textContent = [d.manufacturer, d.model].filter(Boolean).join(" ") || "—";
    const call = String(d.call_label || d.call || "keep").toLowerCase();
    $("d-call").innerHTML = `<span class="pill ${call}">${call}</span>`;
    $("d-glow").textContent = d.glow_score ?? "—";
    $("d-glow").className = glowClass(d.glow_score);
    $("d-batt").textContent =
      d.battery_health != null ? `${d.battery_health}%` : "—";
    $("d-comp").textContent = d.compliance_state || "—";
    $("d-user").textContent = d.user_upn || "—";
    $("d-why").textContent = d.rationale || d.health_notes || "";
  }

  function propRow(label, value) {
    return `<div class="prop-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }

  function inventoryBits(inv) {
    if (!inv || typeof inv !== "object") return { battery: null, signals: {}, storage: [], volumes: [], system: {}, device: {} };
    return {
      battery: inv.battery || null,
      signals: inv.signals || {},
      storage: Array.isArray(inv.storage) ? inv.storage : [],
      volumes: Array.isArray(inv.volumes) ? inv.volumes : [],
      system: inv.system || {},
      device: inv.device || {},
    };
  }

  function renderProperties(d, full) {
    const body = $("propsBody");
    const title = $("p-title");
    if (!d) {
      title.textContent = "No device selected";
      body.innerHTML = `<p class="detail-empty">Pick a device from Fleet, then click Properties.</p>`;
      return;
    }
    title.textContent = d.device_name || d.id || "Device";
    const call = String(d.call_label || "keep").toLowerCase();
    const inv = inventoryBits(full?.inventory || full?.raw?.glowopsInventory || null);
    const batt =
      d.battery_health != null
        ? `${d.battery_health}%`
        : inv.battery?.healthPercent != null
          ? `${inv.battery.healthPercent}%`
          : "—";
    const notes = d.health_notes || d.rationale || (inv.signals.notes || []).join(" ") || "—";

    const volumeRows = (inv.volumes || [])
      .map((v) => {
        const size = Number(v.sizeBytes || 0);
        const free = Number(v.freeBytes || 0);
        const pct = size > 0 ? Math.round((100 * free) / size) : null;
        return `<li><strong>${esc(v.drive || "?")}</strong> ${pct != null ? pct + "% free" : "—"} · ${esc(
          v.fileSystem || ""
        )}</li>`;
      })
      .join("");

    const diskRows = (inv.storage || [])
      .map(
        (s) =>
          `<li><strong>${esc(s.name || s.model || "Disk")}</strong> ${
            s.predictiveFailure ? '<span class="pill recycle">predictive failure</span>' : "ok"
          }</li>`
      )
      .join("");

    body.innerHTML = `
      <div class="props-hero">
        <div>
          <p class="mono">${esc(d.serial_number || "no serial")}</p>
          <p class="props-model">${esc([d.manufacturer, d.model].filter(Boolean).join(" ") || "—")}</p>
          <p class="why">${esc(notes)}</p>
        </div>
        <div class="props-kpis">
          <div><span>Call</span><strong><span class="pill ${call}">${call}</span></strong></div>
          <div><span>GLOW</span><strong class="${glowClass(d.glow_score)}">${esc(d.glow_score ?? "—")}</strong></div>
          <div><span>Battery</span><strong>${esc(batt)}</strong></div>
          <div><span>Age</span><strong>${d.age_years != null ? d.age_years + "y" : "—"}</strong></div>
          <div><span>Last sync</span><strong>${d.check_in_days != null ? d.check_in_days + "d ago" : "—"}</strong></div>
          <div><span>Mfg kg</span><strong>${esc(d.mfg_kg ?? "—")}</strong></div>
        </div>
      </div>

      <div class="props-columns">
        <section class="props-card">
          <h3>Identity</h3>
          ${propRow("Hostname", d.device_name)}
          ${propRow("Serial", d.serial_number)}
          ${propRow("Manufacturer", d.manufacturer)}
          ${propRow("Model", d.model)}
          ${propRow("Class", d.device_class || inv.device.chassis || "—")}
          ${propRow("Source", d.source)}
          ${propRow("Device id", d.id)}
        </section>
        <section class="props-card">
          <h3>Lifecycle</h3>
          ${propRow("Call", call)}
          ${propRow("GLOW score", d.glow_score)}
          ${propRow("Age (years)", d.age_years)}
          ${propRow("Check-in (days)", d.check_in_days)}
          ${propRow("Enrolled", d.enrolled_at)}
          ${propRow("Last sync", d.last_sync_at)}
          ${propRow("Updated", d.updated_at)}
        </section>
        <section class="props-card">
          <h3>Health & security</h3>
          ${propRow("Battery", batt)}
          ${propRow("Compliance", d.compliance_state)}
          ${propRow("BitLocker", inv.signals.bitlockerEnabled == null ? "—" : inv.signals.bitlockerEnabled ? "On" : "Off")}
          ${propRow("TPM", inv.signals.tpmPresent == null ? "—" : inv.signals.tpmPresent ? "Present" : "Missing")}
          ${propRow("Pending reboot", inv.system.pendingReboot == null ? "—" : inv.system.pendingReboot ? "Yes" : "No")}
          ${propRow("User", d.user_upn)}
          ${propRow("OS", [d.operating_system, d.os_version].filter(Boolean).join(" "))}
        </section>
        <section class="props-card">
          <h3>Storage</h3>
          ${diskRows ? `<ul class="props-list">${diskRows}</ul>` : `<p class="hint">No disk inventory on this row yet.</p>`}
          ${volumeRows ? `<h4>Volumes</h4><ul class="props-list">${volumeRows}</ul>` : ""}
        </section>
      </div>
    `;
  }

  function renderDashboard() {
    const grid = $("dashGrid");
    if (!grid) return;
    const by = (summary && summary.byCall) || {};
    const total = summary?.deviceCount || devices.length || 1;
    const callBars = CALLS.filter((c) => c !== "all")
      .map((c) => {
        const n = by[c] || 0;
        const pct = Math.round((100 * n) / total);
        return `<div class="dash-bar"><span>${c}</span><div class="track"><i style="width:${pct}%"></i></div><b>${n}</b></div>`;
      })
      .join("");

    const deviceButtons = [...devices]
      .sort((a, b) => (a.glow_score ?? 999) - (b.glow_score ?? 999))
      .map((d) => {
        const call = String(d.call_label || "keep").toLowerCase();
        return `<li>
          <button type="button" class="dash-device" data-open-props="${esc(d.id)}" title="Open properties">
            <strong>${esc(d.device_name || d.id)}</strong>
            <span class="pill ${call}">${call}</span>
            <em class="${glowClass(d.glow_score)}">${esc(d.glow_score ?? "—")}</em>
          </button>
        </li>`;
      })
      .join("");

    grid.innerHTML = `
      <section class="props-card">
        <h3>Fleet snapshot</h3>
        <div class="props-kpis dash-kpis">
          <div><span>Devices</span><strong>${summary?.deviceCount ?? 0}</strong></div>
          <div><span>Avg GLOW</span><strong>${summary?.avgGlowScore ?? "—"}</strong></div>
          <div><span>Ghosts</span><strong>${summary?.ghostCount ?? 0}</strong></div>
          <div><span>Repair</span><strong>${summary?.repairBeforeReplaceCount ?? 0}</strong></div>
          <div><span>Mfg kg</span><strong>${summary?.manufacturingKgOnBooks ?? 0}</strong></div>
          <div><span>Avoid buy</span><strong>${summary?.avoidablePurchasesIfExtended ?? 0}</strong></div>
        </div>
      </section>
      <section class="props-card">
        <h3>Calls mix</h3>
        <div class="dash-bars">${callBars}</div>
      </section>
      <section class="props-card">
        <h3>Devices — click a name for properties</h3>
        <ul class="dash-list">${deviceButtons || "<li>No devices</li>"}</ul>
      </section>
    `;
  }

  async function openProperties(id) {
    selectedId = String(id);
    const local = findDevice(selectedId);
    propertiesDevice = local;
    renderProperties(local, null);
    setView("properties");
    try {
      const res = await fetch(
        `/api/devices/${encodeURIComponent(selectedId)}?tenant=${encodeURIComponent(tenant())}`
      );
      if (!res.ok) throw new Error("device fetch failed");
      const data = await res.json();
      propertiesDevice = data.device || local;
      renderProperties(propertiesDevice, propertiesDevice);
    } catch (err) {
      console.error(err);
      renderProperties(local, null);
    }
  }

  function renderDevices() {
    pageSize = calcPageSize();
    let rows = filtered();
    if (!rows.length && devices.length && activeCall !== "all" && !(searchEl.value || "").trim()) {
      activeCall = "all";
      rows = filtered();
      renderFilters();
    }

    const pages = Math.max(1, Math.ceil(rows.length / pageSize) || 1);
    if (page >= pages) page = pages - 1;
    if (page < 0) page = 0;
    const slice = rows.slice(page * pageSize, page * pageSize + pageSize);
    emptyEl.hidden = rows.length > 0;
    emptyEl.textContent = devices.length ? "No devices match this filter." : "No devices in this business yet.";
    $("pageInfo").textContent = `${page + 1} / ${pages}`;
    $("prevPage").disabled = page <= 0;
    $("nextPage").disabled = page >= pages - 1;

    const selectedStr = selectedId == null ? null : String(selectedId);
    if (!slice.find((d) => String(d.id) === selectedStr)) {
      selectedId = slice[0] ? String(slice[0].id) : null;
    }

    tbody.innerHTML = slice
      .map((d) => {
        const call = String(d.call_label || d.call || "keep").toLowerCase();
        const glow = d.glow_score;
        const id = String(d.id);
        const sel = id === String(selectedId) ? "is-selected" : "";
        return `<tr class="${sel}" data-id="${esc(id)}">
          <td class="device">
            <button type="button" class="device-link" data-props="${esc(id)}" title="Open properties">
              <strong>${esc(d.device_name || "—")}</strong>
              <span class="serial">${esc(d.serial_number || "")}</span>
            </button>
          </td>
          <td><span class="pill ${call}">${call}</span></td>
          <td class="glow ${glowClass(glow)}">${glow ?? "—"}</td>
          <td>${d.age_years != null ? d.age_years + "y" : "—"}</td>
          <td>${d.check_in_days != null ? d.check_in_days + "d" : "—"}</td>
          <td class="row-actions"><button type="button" class="btn ghost btn-props" data-props="${esc(
            id
          )}">Properties</button></td>
        </tr>`;
      })
      .join("");

    const selected = rows.find((d) => String(d.id) === String(selectedId)) || slice[0] || null;
    showDetail(selected);
  }

  function setView(name) {
    if (!VIEWS.includes(name)) name = "fleet";
    currentView = name;
    const map = {
      fleet: "viewFleet",
      dashboard: "viewDashboard",
      properties: "viewProperties",
      ingest: "viewIngest",
    };
    Object.entries(map).forEach(([key, id]) => {
      const el = $(id);
      if (!el) return;
      const on = key === name;
      el.hidden = !on;
      el.dataset.active = on ? "true" : "false";
    });
    document.querySelectorAll(".view-tab").forEach((tab) => {
      tab.setAttribute("aria-selected", tab.getAttribute("data-view") === name ? "true" : "false");
    });
    if (name === "fleet") {
      requestAnimationFrame(() => {
        renderDevices();
        requestAnimationFrame(renderDevices);
      });
    }
    if (name === "dashboard") renderDashboard();
    if (name === "properties") {
      const d = propertiesDevice || findDevice(selectedId);
      renderProperties(d, propertiesDevice);
    }
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
      summary = await sumRes.json();
      const payload = await devRes.json();
      devices = Array.isArray(payload.devices) ? payload.devices : [];
      page = 0;
      setMeta(summary);
      renderFilters();
      renderDevices();
      if (currentView === "dashboard") renderDashboard();
      statusEl.textContent = `${summary.deviceCount ?? devices.length} scored · ${t}`;
    } catch (err) {
      statusEl.textContent = "Load failed";
      devices = [];
      renderDevices();
      console.error(err);
    }
  }

  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.getAttribute("data-view");
      if (name === "properties") {
        const id = selectedId || devices[0]?.id;
        if (id) openProperties(id);
        else setView("properties");
        return;
      }
      setView(name);
    });
  });

  document.querySelectorAll("[data-back-fleet]").forEach((btn) => {
    btn.addEventListener("click", () => setView("fleet"));
  });
  $("propsToDash")?.addEventListener("click", () => setView("dashboard"));
  $("openProperties")?.addEventListener("click", () => {
    if (selectedId) openProperties(selectedId);
  });

  callsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-call]");
    if (!btn) return;
    activeCall = btn.getAttribute("data-call");
    page = 0;
    renderFilters();
    renderDevices();
  });

  searchEl.addEventListener("input", () => {
    page = 0;
    renderDevices();
  });
  $("prevPage").addEventListener("click", () => {
    page -= 1;
    renderDevices();
  });
  $("nextPage").addEventListener("click", () => {
    page += 1;
    renderDevices();
  });

  tbody.addEventListener("click", (e) => {
    const propsBtn = e.target.closest("[data-props]");
    if (propsBtn) {
      e.preventDefault();
      e.stopPropagation();
      openProperties(propsBtn.getAttribute("data-props"));
      return;
    }
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    // Clicking the row (not only the Properties button) opens properties.
    openProperties(tr.getAttribute("data-id"));
  });

  $("detailBody")?.addEventListener("click", (e) => {
    const propsBtn = e.target.closest("[data-props]");
    if (!propsBtn) return;
    openProperties(propsBtn.getAttribute("data-props"));
  });

  $("dashGrid")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open-props]");
    if (!btn) return;
    openProperties(btn.getAttribute("data-open-props"));
  });

  $("refresh").addEventListener("click", load);
  tenantEl.addEventListener("change", load);
  tenantEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") load();
  });
  window.addEventListener("resize", () => {
    if (currentView === "fleet") renderDevices();
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
      await load();
      setView("fleet");
    } catch (err) {
      st.textContent = String(err.message || err);
    }
  });

  const params = new URLSearchParams(window.location.search);
  const tenantParam = params.get("tenant");
  if (tenantParam) tenantEl.value = tenantParam;
  const callParam = (params.get("call") || "").toLowerCase();
  if (CALLS.includes(callParam)) activeCall = callParam;
  const viewParam = (params.get("view") || "").toLowerCase();
  const deviceParam = params.get("device");

  load().then(() => {
    if (deviceParam) openProperties(deviceParam);
    else if (viewParam === "dashboard") setView("dashboard");
    else if (viewParam === "properties") setView("properties");
    else if (viewParam === "ingest") setView("ingest");
    else setView("fleet");
  });
})();
