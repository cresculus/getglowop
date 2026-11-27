(function () {
  var path = (location.pathname || "/").replace(/\/index\.html$/, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  function on(href) {
    var p = href.split("#")[0];
    return p === path ? ' aria-current="page"' : "";
  }
  var html =
    '<header class="site-nav" id="siteNav">' +
      '<div class="site-nav-inner">' +
        '<a class="wordmark" href="/"><span class="dot" aria-hidden="true"></span>GLOW&nbsp;Ops<sup style="font-size:.55em">™</sup></a>' +
        '<button type="button" class="nav-burger" id="navBurger" aria-expanded="false" aria-controls="siteLinks">Menu</button>' +
        '<nav class="site-links" id="siteLinks" aria-label="Primary">' +
          '<div class="nav-item">' +
            '<button type="button" aria-expanded="false">Product <span class="caret" aria-hidden="true">▾</span></button>' +
            '<div class="mega" role="group" aria-label="Product">' +
              '<div>' +
                '<p class="mega-col-label">Fleet</p>' +
                '<a class="mlink" href="/report.html"' + on("/report.html") + '><strong>GLOW Op Report</strong><span>The keep / repair / recycle call, per serial.</span></a>' +
                '<a class="mlink" href="/how.html"' + on("/how.html") + '><strong>How it is made</strong><span>Intune, RMM, agent, or SCCM — one report.</span></a>' +
                '<a class="mlink" href="/deploy.html"' + on("/deploy.html") + '><strong>One-click deploy</strong><span>Push to Intune, ready-to-join RMM scripts, any PC.</span></a>' +
                '<a class="mlink" href="/cases.html"' + on("/cases.html") + '><strong>Repair pile</strong><span>Ship or drop off the batteries and disks. Buy the rest.</span></a>' +
              '</div>' +
              '<div>' +
                '<p class="mega-col-label">See it</p>' +
                '<a class="mlink" href="/dashboard.html"' + on("/dashboard.html") + '><strong>Sample dashboard</strong><span>Harbor Clinic, 148 devices.</span></a>' +
                '<a class="mlink" href="/app/"><strong>Live dashboard</strong><span>The fleet you are signed into.</span></a>' +
              '</div>' +
              '<a class="mega-promo" href="/tax.html">' +
                '<b>Lower near-term taxable income</b>' +
                '<span>Repair and keep as OpEx. Calendar refresh as CapEx you may not need.</span>' +
                '<em>Tax &amp; spend →</em>' +
              '</a>' +
            '</div>' +
          '</div>' +
          '<div class="nav-item">' +
            '<button type="button" aria-expanded="false">Why GLOW <span class="caret" aria-hidden="true">▾</span></button>' +
            '<div class="mega mega-2" role="group" aria-label="Why GLOW">' +
              '<div>' +
                '<p class="mega-col-label">The argument</p>' +
                '<a class="mlink" href="/why.html"' + on("/why.html") + '><strong>The problem</strong><span>The calendar is buying laptops the fleet does not need.</span></a>' +
                '<a class="mlink" href="/why.html#builder"><strong>Who builds it</strong><span>Intune and go-live work, not a climate lab.</span></a>' +
              '</div>' +
              '<div>' +
                '<p class="mega-col-label">Numbers</p>' +
                '<a class="mlink" href="/calculator.html"' + on("/calculator.html") + '><strong>Calculator</strong><span>Purchases and manufacturing CO₂e the policy skips.</span></a>' +
                '<a class="mlink" href="/tax.html"' + on("/tax.html") + '><strong>Tax &amp; spend</strong><span>OpEx versus CapEx, plus carbon evidence for a CPA.</span></a>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="nav-item">' +
            '<button type="button" aria-expanded="false">Start <span class="caret" aria-hidden="true">▾</span></button>' +
            '<div class="mega mega-2" role="group" aria-label="Start">' +
              '<div>' +
                '<p class="mega-col-label">Talk to us</p>' +
                '<a class="mlink" href="/demo.html"' + on("/demo.html") + '><strong>Get a demo</strong><span>A walkthrough of your fleet, not a slide deck.</span></a>' +
                '<a class="mlink" href="/network.html"' + on("/network.html") + '><strong>Augmatic Network</strong><span>Private toolkit for MSPs, CTOs, and technologists.</span></a>' +
              '</div>' +
              '<div>' +
                '<p class="mega-col-label">Use it</p>' +
                '<a class="mlink" href="/trial.html"' + on("/trial.html") + '><strong>Try it free</strong><span>30-day internal-use license on your own environment.</span></a>' +
                '<a class="mlink" href="/security.html"' + on("/security.html") + '><strong>Per-business security</strong><span>Another company id cannot read your devices.</span></a>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="nav-item"><a href="/security.html"' + on("/security.html") + '>Security</a></div>' +
          '<div class="nav-item">' +
            '<button type="button" aria-expanded="false">Resources <span class="caret" aria-hidden="true">▾</span></button>' +
            '<div class="mega mega-2" role="group" aria-label="Resources">' +
              '<div>' +
                '<p class="mega-col-label">Read</p>' +
                '<a class="mlink" href="/sources.html"' + on("/sources.html") + '><strong>Sources</strong><span>Papers and notes behind the claims.</span></a>' +
                '<a class="mlink" href="/security.html"' + on("/security.html") + '><strong>Security detail</strong><span>TLS, tenancy, and who can open a fleet.</span></a>' +
              '</div>' +
              '<div>' +
                '<p class="mega-col-label">Talk</p>' +
                '<a class="mlink" href="/early.html"' + on("/early.html") + '><strong>Early access</strong><span>Ask for a walkthrough of a real fleet.</span></a>' +
                '<a class="mlink" href="/report.html"' + on("/report.html") + '><strong>Sample rows</strong><span>Five devices, five calls.</span></a>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</nav>' +
        '<a class="nav-cta" href="/demo.html">Get a demo</a>' +
      '</div>' +
    '</header>';
  var mount = document.getElementById("site-nav");
  if (!mount) return;
  mount.outerHTML = html;
  var nav = document.getElementById("siteNav");
  var burger = document.getElementById("navBurger");
  burger.addEventListener("click", function () {
    var open = nav.classList.toggle("is-open");
    burger.setAttribute("aria-expanded", open ? "true" : "false");
  });
  nav.querySelectorAll(".nav-item > button").forEach(function (btn) {
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var item = btn.parentElement;
      var willOpen = !item.classList.contains("open");
      nav.querySelectorAll(".nav-item.open").forEach(function (el) {
        el.classList.remove("open");
        var b = el.querySelector(":scope > button");
        if (b) b.setAttribute("aria-expanded", "false");
      });
      if (willOpen) {
        item.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });
  document.addEventListener("click", function (ev) {
    if (!nav.contains(ev.target)) {
      nav.querySelectorAll(".nav-item.open").forEach(function (el) { el.classList.remove("open"); });
    }
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") {
      nav.classList.remove("is-open");
      burger.setAttribute("aria-expanded", "false");
      nav.querySelectorAll(".nav-item.open").forEach(function (el) { el.classList.remove("open"); });
    }
  });
})();
