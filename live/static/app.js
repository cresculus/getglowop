(() => {
  const $ = (id) => document.getElementById(id);
  const CALLS = ["all", "keep", "repair", "redeploy", "refresh", "recycle", "ghost"];

  let devices = [];
  let summary = null;
  let activeCall = "all";
  let selectedId = null;
  let page = 0;
  let pageSize = 12;

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
    const rowH = 32;
    return Math.max(6, Math.floor(avail / rowH));
  }

  function showDetail(d) {
    if (!d) {
      $("detailEmpty").hidden = false;
      $("detailBody").hidden = true;
      return;
    }
    $("detailEmpty").hidden = true;
    $("detailBody").hidden = false;
    $("d-name").textContent = d.device_name || "—";
    $("d-serial").textContent = d.serial_number || "no serial";
    $("d-model").textContent = [d.manufacturer, d.model].filter(Boolean).join(" ") || "—";
    const call = String(d.call_label || d.call || "keep").toLowerCase();
    $("d-call").innerHTML = `<span class="pill ${call}">${call}</span>`;
    $("d-glow").textContent = d.glow_score ?? "—";
    $("d-glow").className = glowClass(d.glow_score);
    $("d-comp").textContent = d.compliance_state || "—";
    $("d-user").textContent = d.user_upn || "—";
    $("d-why").textContent = d.rationale || d.health_notes || "";
  }

  function renderDevices() {
    pageSize = calcPageSize();
    let rows = filtered();

    // If a deep-linked call filter matches nothing, fall back to All so the fleet is never blank by accident.
    if (!rows.length && devices.length && activeCall !== "all" && !(searchEl.value || "").trim()) {
      activeCall = "all";
      rows = filtered();
      renderFilters();
    }

    const pages = Math.max(1, Math.ceil(rows.length / pageSize) || 1);
    if (page >= pages) page = pages - 1;
    if (page < 0) page = 0;
    const slice = rows.slice(page * pageSize, page * pageSize + pageSize);
    const hasRows = rows.length > 0;
    emptyEl.hidden = hasRows;
    emptyEl.textContent = devices.length
      ? "No devices match this filter."
      : "No devices in this business yet.";
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
          <td class="device"><strong>${esc(d.device_name || "—")}</strong> <span class="serial">${esc(
            d.serial_number || ""
          )}</span></td>
          <td><span class="pill ${call}">${call}</span></td>
          <td class="glow ${glowClass(glow)}">${glow ?? "—"}</td>
          <td>${d.age_years != null ? d.age_years + "y" : "—"}</td>
          <td>${d.check_in_days != null ? d.check_in_days + "d" : "—"}</td>
        </tr>`;
      })
      .join("");

    const selected =
      rows.find((d) => String(d.id) === String(selectedId)) || slice[0] || null;
    showDetail(selected);
  }

  function setView(name) {
    const fleet = $("viewFleet");
    const ingest = $("viewIngest");
    const isFleet = name === "fleet";
    fleet.hidden = !isFleet;
    ingest.hidden = isFleet;
    fleet.dataset.active = isFleet ? "true" : "false";
    ingest.dataset.active = isFleet ? "false" : "true";
    document.querySelectorAll(".view-tab").forEach((tab) => {
      tab.setAttribute("aria-selected", tab.getAttribute("data-view") === name ? "true" : "false");
    });
    if (isFleet) requestAnimationFrame(() => {
      renderDevices();
      requestAnimationFrame(renderDevices);
    });
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
      const list = payload.devices || payload.items || [];
      devices = Array.isArray(list) ? list : [];
      page = 0;
      setMeta(summary);
      renderFilters();
      renderDevices();
      statusEl.textContent = `${summary.deviceCount ?? devices.length} scored · ${t}`;
    } catch (err) {
      statusEl.textContent = "Load failed";
      devices = [];
      renderDevices();
      console.error(err);
    }
  }

  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => setView(tab.getAttribute("data-view")));
  });
  $("backFleet").addEventListener("click", () => setView("fleet"));

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
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    selectedId = tr.getAttribute("data-id");
    renderDevices();
  });

  $("refresh").addEventListener("click", load);
  tenantEl.addEventListener("change", load);
  tenantEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") load();
  });
  window.addEventListener("resize", () => {
    if ($("viewFleet").dataset.active === "true") renderDevices();
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

  load().then(() => {
    if (viewParam === "ingest") setView("ingest");
    else setView("fleet");
  });
})();
