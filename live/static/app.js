(() => {
  const $ = (id) => document.getElementById(id);
  const CALLS = ["all", "keep", "repair", "redeploy", "refresh", "recycle", "ghost"];
  const VIEWS = ["fleet", "dashboard", "properties", "resources", "ingest"];

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

  const TZ_KEY = "glowops_tz";
  function currentTz() {
    return localStorage.getItem(TZ_KEY) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
  function formatWhen(iso) {
    if (!iso) return "—";
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return String(iso);
    try {
      const date = new Intl.DateTimeFormat(undefined, {
        timeZone: currentTz(),
        year: "numeric",
        month: "short",
        day: "2-digit",
      }).format(dt);
      const time = new Intl.DateTimeFormat(undefined, {
        timeZone: currentTz(),
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      }).format(dt);
      return `${date} · ${time}`;
    } catch {
      return String(iso);
    }
  }
  function formatBytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let x = v;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024;
      i += 1;
    }
    return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }
  function yn(v) {
    if (v === true) return "Yes";
    if (v === false) return "No";
    return "—";
  }

  function propRow(label, value) {
    return `<div class="prop-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }

  function inventoryBits(full, d) {
    const inv =
      full?.inventory ||
      full?.raw?.glowopsInventory ||
      (full?.raw?.device ? full.raw : null) ||
      d?.inventory ||
      null;
    const base = inv && typeof inv === "object" ? inv : {};
    return {
      battery: base.battery || null,
      signals: base.signals || d?.signals || {},
      storage: Array.isArray(base.storage) ? base.storage : Array.isArray(d?.storage) ? d.storage : [],
      volumes: Array.isArray(base.volumes) ? base.volumes : Array.isArray(d?.volumes) ? d.volumes : [],
      system: base.system || {},
      device: base.device || {},
      resources: base.resources || d?.resources || {},
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
    const inv = inventoryBits(full || d, d);
    const batt =
      d.battery_health != null
        ? `${d.battery_health}%`
        : inv.battery?.healthPercent != null
          ? `${inv.battery.healthPercent}%`
          : inv.battery?.present === false
            ? "N/A (desktop)"
            : "—";
    const notesArr = [].concat(inv.signals.notes || []).filter(Boolean);
    const notes = d.health_notes || d.rationale || notesArr.join(" ") || "—";
    const res = inv.resources || {};
    const bitlocker =
      d.bitlockerEnabled != null ? d.bitlockerEnabled : inv.signals.bitlockerEnabled;
    const tpm = d.tpmPresent != null ? d.tpmPresent : inv.signals.tpmPresent;
    const reboot =
      d.pendingReboot != null ? d.pendingReboot : inv.system.pendingReboot;

    const volumeRows = (inv.volumes || [])
      .map((v) => {
        const size = Number(v.sizeBytes || 0);
        const free = Number(v.freeBytes || 0);
        const pct = size > 0 ? Math.round((100 * free) / size) : null;
        return `<li><strong>${esc(v.drive || "?")}</strong> ${formatBytes(free)} free of ${formatBytes(
          size
        )}${pct != null ? ` (${pct}%)` : ""} · ${esc(v.fileSystem || "")}</li>`;
      })
      .join("");

    const diskRows = (inv.storage || [])
      .map((s) => {
        const fail = s.predictiveFailure === true;
        return `<li><strong>${esc(s.name || s.model || "Disk")}</strong> ${esc(
          [s.mediaType, s.busType].filter(Boolean).join(" · ")
        )} · ${formatBytes(s.sizeBytes)} ${
          fail ? '<span class="pill recycle">predictive failure</span>' : '<span class="pill keep">healthy</span>'
        }</li>`;
      })
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
          <div><span>RAM used</span><strong>${res.ramUsedPercent != null ? res.ramUsedPercent + "%" : "—"}</strong></div>
          <div><span>CPU load</span><strong>${res.cpuLoadPercent != null ? res.cpuLoadPercent + "%" : "—"}</strong></div>
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
          ${propRow("Enrolled", formatWhen(d.enrolled_at))}
          ${propRow("Last sync", formatWhen(d.last_sync_at))}
          ${propRow("Updated", formatWhen(d.updated_at))}
          ${propRow("Time zone", currentTz())}
        </section>
        <section class="props-card">
          <h3>Health & security</h3>
          ${propRow("Battery", batt)}
          ${propRow("Compliance", d.compliance_state)}
          ${propRow("BitLocker", bitlocker == null ? "—" : bitlocker ? "On" : "Off")}
          ${propRow("TPM", tpm == null ? "—" : tpm ? "Present" : "Missing")}
          ${propRow("Pending reboot", yn(reboot))}
          ${propRow("User", d.user_upn || inv.system.lastInteractiveUser)}
          ${propRow("OS", [d.operating_system || inv.system.osCaption, d.os_version || inv.system.osVersion].filter(Boolean).join(" "))}
        </section>
        <section class="props-card">
          <h3>Resources (agent)</h3>
          ${propRow("CPU", res.cpuName || "—")}
          ${propRow("Cores / logical", res.cpuCores != null ? `${res.cpuCores} / ${res.cpuLogical ?? "—"}` : "—")}
          ${propRow("CPU load", res.cpuLoadPercent != null ? `${res.cpuLoadPercent}%` : "—")}
          ${propRow("RAM total", res.ramTotalMB != null ? `${res.ramTotalMB} MB` : "—")}
          ${propRow("RAM free", res.ramFreeMB != null ? `${res.ramFreeMB} MB` : "—")}
          ${propRow("RAM used", res.ramUsedPercent != null ? `${res.ramUsedPercent}%` : "—")}
        </section>
        <section class="props-card">
          <h3>Storage</h3>
          ${diskRows ? `<ul class="props-list">${diskRows}</ul>` : `<p class="hint">No disk inventory on this row yet. Re-run the GlowOps Agent / collector.</p>`}
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

  function fromPartner() {
    return new URLSearchParams(window.location.search).get("from") === "partner";
  }

  function buildAppUrl(view, deviceId) {
    const params = new URLSearchParams(window.location.search);
    params.set("tenant", tenant());
    if (fromPartner()) params.set("from", "partner");
    else params.delete("from");
    if (view && view !== "fleet") params.set("view", view);
    else params.delete("view");
    if (deviceId && view === "properties") params.set("device", String(deviceId));
    else params.delete("device");
    // Keep call filter in the URL when on fleet
    if (view === "fleet" && activeCall && activeCall !== "all") params.set("call", activeCall);
    else if (view !== "fleet") {
      /* leave call param if present so returning to fleet restores it */
    }
    const qs = params.toString();
    return `/app/${qs ? `?${qs}` : ""}`;
  }

  function syncUrl(view, deviceId, { push = false } = {}) {
    const url = buildAppUrl(view, deviceId);
    const state = { view, deviceId: deviceId || null };
    if (push) history.pushState(state, "", url);
    else history.replaceState(state, "", url);
  }

  function updateHomeBack() {
    const btn = $("homeBack");
    if (!btn) return;
    if (currentView === "fleet") {
      btn.textContent = "← Partner";
      btn.title = "Partner home";
      btn.dataset.mode = "partner";
    } else {
      btn.textContent = "← Fleet report";
      btn.title = "Back to device list";
      btn.dataset.mode = "fleet";
    }
  }

  function goFleet({ push = false } = {}) {
    setView("fleet", { sync: false });
    syncUrl("fleet", null, { push });
    updateHomeBack();
  }

  async function openProperties(id, { push = true } = {}) {
    selectedId = String(id);
    const local = findDevice(selectedId);
    propertiesDevice = local;
    renderProperties(local, null);
    const shouldPush = push && currentView !== "properties";
    setView("properties", { sync: false });
    syncUrl("properties", selectedId, { push: shouldPush });
    updateHomeBack();
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

  function setView(name, { sync = true, push = false } = {}) {
    if (!VIEWS.includes(name)) name = "fleet";
    currentView = name;
    const map = {
      fleet: "viewFleet",
      dashboard: "viewDashboard",
      properties: "viewProperties",
      resources: "viewResources",
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
    if (sync) {
      const deviceId = name === "properties" ? selectedId : null;
      syncUrl(name, deviceId, { push });
    }
    updateHomeBack();
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
        if (id) openProperties(id, { push: true });
        else setView("properties", { push: true });
        return;
      }
      setView(name, { push: true });
    });
  });

  document.querySelectorAll("[data-back-fleet]").forEach((btn) => {
    btn.addEventListener("click", () => goFleet({ push: false }));
  });
  $("homeBack")?.addEventListener("click", () => {
    const mode = $("homeBack")?.dataset?.mode || "fleet";
    if (mode === "partner" || currentView === "fleet") {
      window.location.href = "/partner/";
      return;
    }
    goFleet({ push: false });
  });
  $("propsToDash")?.addEventListener("click", () => setView("dashboard", { push: true }));
  $("openProperties")?.addEventListener("click", () => {
    if (selectedId) openProperties(selectedId, { push: true });
  });
  window.addEventListener("popstate", (e) => {
    const st = e.state || {};
    const params = new URLSearchParams(window.location.search);
    const view = st.view || params.get("view") || "fleet";
    const device = st.deviceId || params.get("device");
    if (view === "properties" && device) {
      openProperties(device, { push: false });
      return;
    }
    setView(VIEWS.includes(view) ? view : "fleet", { sync: false });
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
      goFleet({ push: false });
    } catch (err) {
      st.textContent = String(err.message || err);
    }
  });

  const tzSelect = $("tzSelect");
  if (tzSelect) {
    const zones = [
      currentTz(),
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "UTC",
      "Europe/London",
      "Europe/Berlin",
    ];
    const uniq = [...new Set(zones)];
    tzSelect.innerHTML = uniq.map((z) => `<option value="${esc(z)}">${esc(z)}</option>`).join("");
    tzSelect.value = currentTz();
    tzSelect.addEventListener("change", () => {
      localStorage.setItem(TZ_KEY, tzSelect.value);
      if (currentView === "properties") {
        const d = propertiesDevice || findDevice(selectedId);
        renderProperties(d, propertiesDevice);
      }
      renderDevices();
    });
  }

  const params = new URLSearchParams(window.location.search);
  const tenantParam = params.get("tenant");
  if (tenantParam) tenantEl.value = tenantParam;
  const callParam = (params.get("call") || "").toLowerCase();
  if (CALLS.includes(callParam)) activeCall = callParam;
  const viewParam = (params.get("view") || "").toLowerCase();
  const deviceParam = params.get("device");

  load().then(() => {
    if (deviceParam) openProperties(deviceParam, { push: false });
    else if (viewParam === "dashboard") setView("dashboard", { sync: true });
    else if (viewParam === "properties") setView("properties", { sync: true });
    else if (viewParam === "resources") setView("resources", { sync: true });
    else if (viewParam === "ingest") setView("ingest", { sync: true });
    else setView("fleet", { sync: true });
  });
})();
