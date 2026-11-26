(function () {
  var mount = document.getElementById("site-foot");
  if (!mount) return;
  mount.outerHTML =
    '<footer><div class="wrap">' +
      '<p class="f-big">The report is<br />the <span class="glow">product.</span></p>' +
      '<p class="f-meta">GLOW Ops · Green Lifecycle and Operation Workflows · getglowop.com</p>' +
      '<a class="mail" href="mailto:brandon.sardelli@gmail.com?subject=GLOW%20Ops%20%E2%80%94%20early%20access">Ask about early access →</a>' +
      '<p class="f-fine">The GLOW Op Report is the product. Phase 0 brand site. The calculator is a screening tool with the assumptions printed on it — not an assurance opinion, a GHG inventory, tax advice, or a reason to skip a security patch. GLOW™, GLOW Ops™, and GLOW Op Report™ are trademarks of Augmatic Holdings LLC. <a href="https://augmaticholdings.com/" style="color:var(--lime-deep);text-decoration:underline;font-weight:700">Augmatic Holdings LLC →</a> · <a href="/network.html" style="color:var(--lime-deep);text-decoration:underline;font-weight:700">Augmatic Network →</a> · <a href="/security.html" style="color:var(--lime-deep);text-decoration:underline;font-weight:700">Security →</a></p>' +
    '</div></footer>';
})();
