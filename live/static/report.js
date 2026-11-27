/* Printable device summary. Print saves a PDF. Send opens the mail client. */
(function () {
  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function num(v) {
    return v == null || v === "" ? "—" : String(v);
  }

  function row(d) {
    const maker = [d.manufacturer, d.model].filter(Boolean).join(" ");
    return {
      name: d.device_name || d.name || "—",
      serial: d.serial_number || d.serial || "",
      model: maker || d.modelLine || "",
      call: String(d.call_label || d.call || "keep").toLowerCase(),
      glow: num(d.glow_score != null ? d.glow_score : d.glow),
      age: d.age_years != null ? d.age_years + "y" : d.age || "—",
      sync: d.check_in_days != null ? d.check_in_days + "d" : d.sync || "—",
      battery: d.battery_health != null ? d.battery_health + "%" : d.battery || "—",
      kg: num(d.mfg_kg != null ? d.mfg_kg : d.kg),
      why: d.rationale || d.why || "",
    };
  }

  function kpisOf(summary, devices) {
    const list = devices || [];
    return {
      devices: summary?.deviceCount != null ? summary.deviceCount : list.length,
      glow: summary?.avgGlowScore != null ? summary.avgGlowScore : "—",
      ghosts: summary?.ghostCount != null ? summary.ghostCount : list.filter((d) => row(d).call === "ghost").length,
      repair: summary?.repairBeforeReplaceCount != null ? summary.repairBeforeReplaceCount : list.filter((d) => row(d).call === "repair").length,
      kg: summary?.manufacturingKgOnBooks != null ? summary.manufacturingKgOnBooks : "—",
    };
  }

  function build(doc) {
    const sections = (doc.sections || []).map((s) => ({
      name: s.name || "Business",
      kpis: kpisOf(s.summary, s.devices),
      devices: (s.devices || []).map(row),
    }));
    const all = sections.flatMap((s) => s.devices);
    return {
      title: doc.title || "Fleet",
      when: new Date().toLocaleString(),
      kpis: doc.kpis || kpisOf(null, all),
      sections,
    };
  }

  function table(devices) {
    if (!devices.length) return "<p>No devices in this business.</p>";
    const body = devices
      .map(
        (d) => `<tr>
          <td><b>${esc(d.name)}</b><br><span class="sub">${esc(d.serial)} ${esc(d.model)}</span></td>
          <td>${esc(d.call)}</td>
          <td>${esc(d.glow)}</td>
          <td>${esc(d.age)}</td>
          <td>${esc(d.sync)}</td>
          <td>${esc(d.battery)}</td>
          <td>${esc(d.kg)}</td>
          <td>${esc(d.why)}</td>
        </tr>`
      )
      .join("");
    return `<table>
      <thead><tr><th>Device</th><th>Call</th><th>GLOW</th><th>Age</th><th>Sync</th><th>Battery</th><th>Mfg kg</th><th>Why</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  function kpiLine(k) {
    return `<p class="kpis"><b>${esc(k.devices)}</b> devices · GLOW ${esc(k.glow)} · ghosts ${esc(k.ghosts)} · repair ${esc(k.repair)} · mfg kg ${esc(k.kg)}</p>`;
  }

  function html(doc) {
    const built = doc.sections ? doc : build(doc);
    const blocks = built.sections
      .map((s) => `<section><h2>${esc(s.name)}</h2>${kpiLine(s.kpis)}${table(s.devices)}</section>`)
      .join("");
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(built.title)}</title>
      <style>
        body { font: 14px/1.4 Archivo, system-ui, sans-serif; color: #14180f; margin: 24px; }
        h1 { font-size: 22px; margin: 0 0 4px; }
        h2 { font-size: 16px; margin: 22px 0 6px; }
        .meta, .sub { color: #697160; font-size: 12px; }
        .kpis { margin: 8px 0 12px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border-bottom: 1px solid #d9dece; text-align: left; vertical-align: top; padding: 6px 8px 6px 0; font-size: 12px; }
        th { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #697160; }
        .bar { display: flex; gap: 8px; margin: 16px 0; }
        button { font: inherit; padding: 8px 12px; border: 1px solid #c5cbb8; background: #fff; cursor: pointer; }
        button.lime { background: #d7df23; border-color: #d7df23; }
        @media print { .bar { display: none; } body { margin: 0; } }
      </style></head><body>
      <div class="bar">
        <button class="lime" onclick="print()">Print / Save PDF</button>
        <button onclick="window.close()">Close</button>
      </div>
      <h1>${esc(built.title)}</h1>
      <p class="meta">${esc(built.when)} · ${built.sections.length > 1 ? "Every business" : "This business"}</p>
      ${built.sections.length > 1 ? kpiLine(built.kpis) : ""}
      ${blocks}
      <p class="meta">Repair rows are the machines to ship or drop off. Replace rows are the ones to buy.</p>
      </body></html>`;
  }

  function plain(doc) {
    const built = doc.sections ? doc : build(doc);
    const lines = [built.title, built.when, ""];
    if (built.sections.length > 1) {
      const k = built.kpis;
      lines.push(`All businesses: ${k.devices} devices, GLOW ${k.glow}, ghosts ${k.ghosts}, repair ${k.repair}, mfg kg ${k.kg}`, "");
    }
    built.sections.forEach((s) => {
      lines.push(s.name);
      lines.push(`${s.kpis.devices} devices · GLOW ${s.kpis.glow} · ghosts ${s.kpis.ghosts} · repair ${s.kpis.repair} · mfg kg ${s.kpis.kg}`);
      s.devices.forEach((d) => {
        lines.push(`- ${d.name} | ${d.serial} | ${d.model} | ${d.call} | GLOW ${d.glow} | age ${d.age} | sync ${d.sync} | battery ${d.battery} | ${d.kg} kg | ${d.why}`);
      });
      if (!s.devices.length) lines.push("- No devices");
      lines.push("");
    });
    lines.push("Repair rows are the machines to ship or drop off. Replace rows are the ones to buy.");
    return lines.join("\n");
  }

  function openPrint(doc) {
    const built = build(doc);
    const w = window.open("", "_blank");
    if (!w) {
      alert("Allow pop-ups to print the report.");
      return;
    }
    w.document.open();
    w.document.write(html(built));
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 250);
  }

  async function send(doc) {
    const built = build(doc);
    const to = window.prompt("Send this report to", "");
    if (!to) return;
    const full = plain(built);
    let body = full;
    if (full.length > 6000) {
      try { await navigator.clipboard.writeText(full); } catch (_) {}
      body = `${built.title}\n${built.when}\n\n${built.kpis.devices} devices across ${built.sections.length} business(es).\n\nThe full device list was copied to the clipboard. Paste it into this email, or use Print PDF and attach the file.`;
    }
    window.location.href = `mailto:${encodeURIComponent(to.trim())}?subject=${encodeURIComponent(built.title)}&body=${encodeURIComponent(body)}`;
  }

  window.GlowReport = { build, openPrint, send };
})();
