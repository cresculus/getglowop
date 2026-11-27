(() => {
  const $ = (id) => document.getElementById(id);
  const CALLS = ["all", "keep", "repair", "redeploy", "refresh", "recycle", "ghost"];
  // Top nav: Fleet → Dashboard → Resources → Properties → Settings.
  // Ingest stays lab-only (opened from Resources).
  const VIEWS = ["fleet", "dashboard", "resources", "properties", "settings", "logs", "ingest"];

  let devices = [];
  let summary = null;
  let activeCall = "all";
  let selectedId = null;
  let page = 0;
  let pageSize = 12;
  let currentView = "fleet";
  let propertiesDevice = null;

  const tenantEl = $("tenant");
  const bizNameLabel = $("bizNameLabel");
  const bizNameInput = $("bizNameInput");
  const statusEl = $("status");
  const tbody = $("tbody");
  const callsEl = $("calls");
  const emptyEl = $("empty");
  const searchEl = $("search");
  let bizNameSaved = "My business";
  let authToken = null;
  let signedIn = false;

  function tenant() {
    return (tenantEl.value || "").trim();
  }

  function apiHeaders(extra) {
    const h = Object.assign({ Accept: "application/json" }, extra || {});
    if (authToken) h.Authorization = `Bearer ${authToken}`;
    return h;
  }

  function setBizNameDisplay(name) {
    const label = (name || tenant() || "Business").trim();
    bizNameSaved = label;
    if (bizNameLabel) bizNameLabel.textContent = label;
    if (bizNameInput && document.activeElement !== bizNameInput) {
      bizNameInput.value = label;
    }
  }

  async function saveBizNameFromSettings(nextRaw) {
    const next = (nextRaw || "").trim();
    const st = $("bizRenameStatus");
    if (!next) {
      if (st) st.textContent = "Enter a name.";
      return;
    }
    if (next === bizNameSaved) {
      if (st) st.textContent = "No change.";
      return;
    }
    if (!tenant()) {
      if (st) st.textContent = "Sign in first — no business selected.";
      return;
    }
    if (st) st.textContent = "Saving…";
    try {
      const res = await fetch("/api/business", {
        method: "POST",
        headers: apiHeaders({ "Content-Type": "application/json" }),
        credentials: "same-origin",
        body: JSON.stringify({ tenantId: tenant(), name: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "rename failed");
      setBizNameDisplay(data.business?.name || next);
      if (st) st.textContent = "Saved.";
      if (statusEl && summary) {
        const n = summary.deviceCount ?? devices.length;
        statusEl.textContent =
          n === 0 ? `Empty fleet · ${bizNameSaved}` : `${n} scored · ${bizNameSaved}`;
      }
    } catch (err) {
      console.error(err);
      if (bizNameInput) bizNameInput.value = bizNameSaved;
      if (st) st.textContent = String(err.message || err);
    }
  }

  function glowClass(n) {
    if (n == null) return "mid";
    if (n < 40) return "low";
    if (n < 60) return "mid";
    return "high";
  }

  /** GLOW™ = Green Lifecycle score (common-law TM claim until ® registration). */
  function glowMarkHtml({ info = false, avg = false } = {}) {
    const label = avg ? "Avg GLOW" : "GLOW";
    const tip = info
      ? `<button type="button" class="glow-info" aria-label="What is GLOW score?" aria-haspopup="dialog">i</button>`
      : "";
    return `<span class="glow-mark">${label}<sup class="tm" aria-label="trademark">™</sup>${tip}</span>`;
  }

  function openGlowInfo() {
    const modal = $("glowInfoModal");
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add("glow-modal-open");
    $("glowInfoClose")?.focus();
  }

  function closeGlowInfo() {
    const modal = $("glowInfoModal");
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove("glow-modal-open");
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
    syncKpiSummary();
  }

  function renderFilters() {
    const by = (summary && summary.byCall) || {};
    const total = summary ? summary.deviceCount || 0 : devices.length;
    const labels = {
      all: "All",
      keep: "Keep",
      repair: "Repair",
      redeploy: "Redeploy",
      refresh: "Refresh",
      recycle: "Recycle",
      ghost: "Ghost",
    };
    callsEl.innerHTML = CALLS.map((k) => {
      const count = k === "all" ? total : by[k] || 0;
      const pressed = activeCall === k ? "true" : "false";
      const label = labels[k] || k;
      return `<button type="button" class="chip" data-call="${k}" aria-pressed="${pressed}"><span>${label}</span><b>${count}</b></button>`;
    }).join("");
  }

  function syncKpiSummary() {
    const el = $("kpiSummaryText");
    if (!el) return;
    const n = summary?.deviceCount ?? devices.length;
    const attention =
      (summary?.ghostCount || 0) + (summary?.repairBeforeReplaceCount || 0);
    el.textContent =
      attention > 0
        ? `${n} devices · ${attention} need attention`
        : `${n} devices`;
  }

  function setUpdatedAgo(text) {
    const el = $("updatedAgo");
    if (el) el.textContent = text || "Updated just now";
  }

  function isNarrowDetail() {
    return window.matchMedia("(max-width: 960px)").matches;
  }

  function openDetailDrawer() {
    const pane = $("detailPane");
    const backdrop = $("detailBackdrop");
    const closeBtn = $("detailClose");
    if (!pane) return;
    if (isNarrowDetail()) {
      pane.classList.add("is-open");
      if (backdrop) backdrop.hidden = false;
      if (closeBtn) closeBtn.hidden = false;
    } else {
      pane.classList.remove("is-open");
      if (backdrop) backdrop.hidden = true;
      if (closeBtn) closeBtn.hidden = true;
    }
  }

  function closeDetailDrawer() {
    const pane = $("detailPane");
    const backdrop = $("detailBackdrop");
    const closeBtn = $("detailClose");
    if (pane) pane.classList.remove("is-open");
    if (backdrop) backdrop.hidden = true;
    if (closeBtn) closeBtn.hidden = true;
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
    return Math.max(6, Math.floor(avail / 40));
  }

  function showDetail(d, { openDrawer = false } = {}) {
    if (!d) {
      $("detailEmpty").hidden = false;
      $("detailBody").hidden = true;
      closeDetailDrawer();
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
    const cls = String(d.device_class || "").toLowerCase();
    $("d-batt").textContent =
      d.battery_health != null
        ? `${d.battery_health}%`
        : cls === "desktop"
          ? "N/A"
          : "—";
    $("d-comp").textContent = d.compliance_state || "—";
    $("d-user").textContent = d.user_upn || "—";
    $("d-why").textContent = d.rationale || d.health_notes || "";
    if (openDrawer || isNarrowDetail()) openDetailDrawer();
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

  function propRowHtml(labelHtml, value) {
    return `<div class="prop-row"><span>${labelHtml}</span><strong>${esc(value)}</strong></div>`;
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

  function renderProperties(d, full, { loading = false } = {}) {
    const body = $("propsBody");
    const title = $("p-title");
    if (!d) {
      title.textContent = "No device selected";
      body.innerHTML = `<p class="detail-empty">Pick a device from Fleet to open it.</p>`;
      return;
    }
    title.textContent = d.device_name || d.id || "Device";
    const call = String(d.call_label || "keep").toLowerCase();
    const inv = inventoryBits(full || d, d);
    const waitingInventory = loading && !(inv.storage || []).length && !(inv.resources || {}).cpuName;
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
          <div><span>${glowMarkHtml({ info: true })}</span><strong class="${glowClass(d.glow_score)}">${esc(d.glow_score ?? "—")}</strong></div>
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
          ${propRowHtml(glowMarkHtml({ info: true }) + " score", d.glow_score)}
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
          ${
            diskRows
              ? `<ul class="props-list">${diskRows}</ul>`
              : waitingInventory
                ? `<p class="hint">Loading inventory…</p>`
                : `<p class="hint">No disk inventory on this row yet. Re-run the GlowOps Agent / collector.</p>`
          }
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
          <div><span>${glowMarkHtml({ avg: true, info: true })}</span><strong>${summary?.avgGlowScore ?? "—"}</strong></div>
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
    // Partner home is always the first top-bar control (#partnerBack).
    // Fleet return uses the Fleet tab + bottom dock — no second top Back.
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
    renderProperties(local, null, { loading: true });
    const shouldPush = push && currentView !== "properties";
    setView("properties", { sync: false });
    syncUrl("properties", selectedId, { push: shouldPush });
    updateHomeBack();
    try {
      const res = await fetch(
        `/api/devices/${encodeURIComponent(selectedId)}?tenant=${encodeURIComponent(tenant())}`,
        { credentials: "same-origin", headers: apiHeaders() }
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
    const emptyFilter = $("emptyFilter");
    const emptyConnect = $("emptyConnect");
    const emptyBiz = $("emptyBizName");
    if (emptyBiz) emptyBiz.textContent = bizNameSaved || "this business";
    if (devices.length) {
      if (emptyFilter) emptyFilter.hidden = false;
      if (emptyConnect) emptyConnect.hidden = true;
    } else {
      if (emptyFilter) emptyFilter.hidden = true;
      if (emptyConnect) emptyConnect.hidden = false;
    }
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
        return `<tr class="${sel}" data-id="${esc(id)}" tabindex="0" role="link" title="Open device">
          <td class="device">
            <span class="device-link">
              <strong>${esc(d.device_name || "—")}</strong>
              <span class="serial">${esc(d.serial_number || "")}</span>
            </span>
          </td>
          <td><span class="pill ${call}">${call}</span></td>
          <td class="glow ${glowClass(glow)}">${glow ?? "—"}</td>
          <td>${d.age_years != null ? d.age_years + "y" : "—"}</td>
          <td>${d.check_in_days != null ? d.check_in_days + "d" : "—"}</td>
        </tr>`;
      })
      .join("");

    const selected = rows.find((d) => String(d.id) === String(selectedId)) || slice[0] || null;
    showDetail(selected, { openDrawer: false });
  }

  async function loadLogs() {
    const body = $("logsBody");
    const empty = $("logsEmpty");
    if (!body) return;
    if (!signedIn) {
      body.innerHTML = "";
      if (empty) empty.textContent = "Sign in to see logs.";
      return;
    }
    try {
      const res = await fetch("/api/logs", { credentials: "same-origin", headers: apiHeaders() });
      const data = await res.json();
      const rows = Array.isArray(data.logs) ? data.logs : [];
      const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      body.innerHTML = rows.map((row) => {
        const when = row.at ? new Date(row.at).toLocaleString() : "—";
        const detail = row.detail ? JSON.stringify(row.detail) : "";
        return `<tr><td>${esc(when)}</td><td>${esc(row.action || "—")}</td><td>${esc(row.businessId || "—")}</td><td class="mono">${esc(detail)}</td></tr>`;
      }).join("");
      if (empty) empty.textContent = rows.length ? "" : "No log rows yet.";
    } catch (err) {
      if (empty) empty.textContent = "Could not load logs.";
    }
  }

  function setView(name, { sync = true, push = false } = {}) {
    if (!VIEWS.includes(name)) name = "fleet";
    currentView = name;
    const map = {
      fleet: "viewFleet",
      dashboard: "viewDashboard",
      properties: "viewProperties",
      resources: "viewResources",
      settings: "viewSettings",
      logs: "viewLogs",
      ingest: "viewIngest",
    };
    Object.entries(map).forEach(([key, id]) => {
      const el = $(id);
      if (!el) return;
      const on = key === name;
      el.hidden = !on;
      el.dataset.active = on ? "true" : "false";
    });
    document.querySelectorAll(".view-tab, #bottomNav button").forEach((tab) => {
      tab.setAttribute("aria-selected", tab.getAttribute("data-view") === name ? "true" : "false");
    });
    if (name !== "fleet") closeDetailDrawer();
    if (name === "fleet") {
      requestAnimationFrame(() => {
        renderDevices();
        requestAnimationFrame(renderDevices);
      });
    }
    if (name === "dashboard") renderDashboard();
    if (name === "logs") loadLogs();
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
    if (!t) {
      devices = [];
      summary = {
        deviceCount: 0,
        avgGlowScore: null,
        ghostCount: 0,
        repairBeforeReplaceCount: 0,
        manufacturingKgOnBooks: 0,
        avoidablePurchasesIfExtended: 0,
        byCall: {},
        businessName: bizNameSaved,
      };
      setMeta(summary);
      renderFilters();
      renderDevices();
      statusEl.textContent = signedIn
        ? "No business yet — creating…"
        : "Sign in to open your empty fleet dashboard";
      return;
    }
    $("exportCsv").href = `/api/export.csv?tenant=${encodeURIComponent(t)}`;
    statusEl.textContent = "Loading…";
    try {
      const [sumRes, devRes] = await Promise.all([
        fetch(`/api/summary?tenant=${encodeURIComponent(t)}`, {
          credentials: "same-origin",
          headers: apiHeaders(),
        }),
        fetch(`/api/devices?tenant=${encodeURIComponent(t)}`, {
          credentials: "same-origin",
          headers: apiHeaders(),
        }),
      ]);
      if (!sumRes.ok || !devRes.ok) throw new Error("API error");
      summary = await sumRes.json();
      const payload = await devRes.json();
      devices = Array.isArray(payload.devices) ? payload.devices : [];
      page = 0;
      setBizNameDisplay(summary.businessName || t);
      setMeta(summary);
      renderFilters();
      renderDevices();
      if (currentView === "dashboard") renderDashboard();
      const n = summary.deviceCount ?? devices.length;
      statusEl.textContent =
        n === 0
          ? `Empty fleet · ${summary.businessName || t}`
          : `${n} scored · ${summary.businessName || t}`;
      setUpdatedAgo("Updated just now");
    } catch (err) {
      statusEl.textContent = "Load failed";
      devices = [];
      renderDevices();
      console.error(err);
    }
  }

  function bindViewTabs(selector) {
    document.querySelectorAll(selector).forEach((tab) => {
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
  }
  bindViewTabs(".view-tab");
  bindViewTabs("#bottomNav button");

  $("detailClose")?.addEventListener("click", () => closeDetailDrawer());
  $("detailBackdrop")?.addEventListener("click", () => closeDetailDrawer());
  $("kpiSummary")?.addEventListener("click", () => {
    $("statsPane")?.classList.toggle("is-expanded");
  });
  window.addEventListener("resize", () => {
    if (!isNarrowDetail()) closeDetailDrawer();
  });

  document.querySelectorAll("[data-back-fleet]").forEach((btn) => {
    btn.addEventListener("click", () => goFleet({ push: false }));
  });
  $("propsToDash")?.addEventListener("click", () => setView("dashboard", { push: true }));
  $("openLabIngest")?.addEventListener("click", () => setView("ingest", { push: true }));
  document.querySelectorAll("[data-empty-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.getAttribute("data-empty-action");
      if (action === "intune") {
        setView("resources", { push: true });
        return;
      }
      if (action === "ingest") {
        setView("ingest", { push: true });
        return;
      }
      if (action === "agent") {
        const t = tenant();
        const q = t ? `?view=enroll&tenant=${encodeURIComponent(t)}` : "?view=enroll";
        window.location.href = `/partner/${q}`;
      }
    });
  });
  document.querySelectorAll("[data-view]:not(.view-tab)").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.getAttribute("data-view");
      if (name) setView(name, { push: true });
    });
  });
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

  document.addEventListener(
    "click",
    (e) => {
      const infoBtn = e.target.closest(".glow-info");
      if (infoBtn) {
        e.preventDefault();
        e.stopPropagation();
        openGlowInfo();
        return;
      }
      if (e.target.closest("#glowInfoClose") || e.target.closest("#glowInfoBackdrop")) {
        e.preventDefault();
        closeGlowInfo();
      }
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeGlowInfo();
  });
  $("glowInfoClose")?.addEventListener("click", closeGlowInfo);
  $("glowInfoBackdrop")?.addEventListener("click", closeGlowInfo);

  tbody.addEventListener("click", (e) => {
    if (e.target.closest(".glow-info")) return;
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    openProperties(tr.getAttribute("data-id"));
  });
  tbody.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest(".glow-info")) return;
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    e.preventDefault();
    openProperties(tr.getAttribute("data-id"));
  });

  $("detailBody")?.addEventListener("click", (e) => {
    if (e.target.closest(".glow-info")) return;
    if (e.target.closest("button, a")) return;
    if (selectedId) openProperties(selectedId);
  });

  $("dashGrid")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open-props]");
    if (!btn) return;
    openProperties(btn.getAttribute("data-open-props"));
  });

  $("refresh").addEventListener("click", load);
  function fleetDoc() {
    const name = bizNameSaved || (summary && summary.businessName) || "Business";
    return { title: name, sections: [{ name, summary, devices }] };
  }
  const printReport = $("printReport");
  const sendReport = $("sendReport");
  if (printReport) printReport.addEventListener("click", () => GlowReport.openPrint(fleetDoc()));
  if (sendReport) sendReport.addEventListener("click", () => GlowReport.send(fleetDoc()));
  $("bizRenameForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    saveBizNameFromSettings(bizNameInput?.value);
  });
  $("bizBadge")?.addEventListener("click", () => setView("settings", { push: true }));
  $("bizBadge")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setView("settings", { push: true });
    }
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

  function setSignedInChrome(email) {
    const signIn = $("fleetSignIn");
    const settingsSignIn = $("settingsSignIn");
    const who = $("settingsWho");
    const people = $("managePeople");
    if (signIn) signIn.hidden = true;
    const sideName = $("sideUserName");
    const sideAvatar = document.querySelector(".side-avatar");
    if (sideName) sideName.textContent = email || "Signed in";
    if (sideAvatar) {
      const bits = String(email || "G").split(/[@\s.]+/).filter(Boolean);
      sideAvatar.textContent = (bits[0] || "G").slice(0, 1).toUpperCase();
    }
    if (settingsSignIn) settingsSignIn.hidden = true;
    if (who) who.textContent = email ? `Signed in as ${email}` : "Signed in.";
    if (people) people.hidden = false;
  }

  function setSignedOutChrome() {
    const signIn = $("fleetSignIn");
    const settingsSignIn = $("settingsSignIn");
    const who = $("settingsWho");
    const people = $("managePeople");
    const ub = $("userButton");
    if (signIn) signIn.hidden = false;
    const sideName = $("sideUserName");
    if (sideName) sideName.textContent = "Signed out";
    if (settingsSignIn) settingsSignIn.hidden = false;
    if (who) who.textContent = "Not signed in.";
    if (people) people.hidden = true;
    if (ub) ub.hidden = true;
  }

  async function initFleetAuth() {
    setSignedOutChrome();
    if (!window.GlowClerkPartner) return false;
    try {
      const cfg = await GlowClerkPartner.fetchPublicConfig();
      if (!cfg.clerk?.enabled || !cfg.clerk.publishableKey) return false;
      const clerk = await GlowClerkPartner.createClerk(cfg.clerk.publishableKey);
      if (!clerk.session) {
        if (!tenantParam) {
          tenantEl.value = "";
          statusEl.textContent = "Sign in to open your fleet dashboard";
        }
        return false;
      }
      authToken = await GlowClerkPartner.sessionToken(clerk);
      const res = await fetch("/api/partner/me", {
        credentials: "same-origin",
        headers: apiHeaders(),
      });
      if (!res.ok) return false;
      const data = await res.json();
      signedIn = true;
      const clerkEmail =
        clerk.user?.primaryEmailAddress?.emailAddress ||
        clerk.user?.emailAddresses?.[0]?.emailAddress ||
        "";
      const email =
        clerkEmail || data.partner?.email || data.partner?.name || "Signed in";
      setSignedInChrome(email);
      GlowClerkPartner.mountUserButton(clerk, $("userButton"));

      const roles = Array.isArray(data.roles) ? data.roles : [];
      const allowed = new Set(roles.map((r) => r.businessId).filter(Boolean));
      let bizId = data.primaryBusinessId || roles[0]?.businessId || "";
      let bizName = data.primaryBusinessName || roles[0]?.businessName || "My business";
      if (tenantParam && allowed.has(tenantParam)) {
        bizId = tenantParam;
        const hit = roles.find((r) => r.businessId === tenantParam);
        if (hit) bizName = hit.businessName || bizId;
      }
      if (bizId === "demo") {
        bizId = data.primaryBusinessId || "";
        bizName = data.primaryBusinessName || "My business";
      }
      if (bizId) {
        tenantEl.value = bizId;
        setBizNameDisplay(bizName);
        const url = new URL(window.location.href);
        url.searchParams.set("from", "partner");
        url.searchParams.set("tenant", bizId);
        if (!url.searchParams.get("view")) url.searchParams.set("view", "fleet");
        history.replaceState(history.state, "", url.pathname + "?" + url.searchParams.toString());
      }
      return true;
    } catch (err) {
      console.warn("fleet auth", err);
      return false;
    }
  }

  initFleetAuth()
    .then(() => load())
    .then(() => {
      if (deviceParam) openProperties(deviceParam, { push: false });
      else if (viewParam === "dashboard") setView("dashboard", { sync: true });
      else if (viewParam === "properties") setView("properties", { sync: true });
      else if (viewParam === "resources") setView("resources", { sync: true });
      else if (viewParam === "settings") setView("settings", { sync: true });
      else if (viewParam === "ingest") setView("ingest", { sync: true });
      else setView("fleet", { sync: true });
    });
})();
