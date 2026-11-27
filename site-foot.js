(function () {
  var mount = document.getElementById("site-foot");
  if (!mount) return;
  var link = 'style="color:var(--lime-deep);text-decoration:underline;font-weight:700"';
  mount.outerHTML =
    '<footer><div class="wrap">' +
      '<p class="f-fine"><a href="https://augmaticholdings.com/" ' + link + '>Augmatic Holdings LLC →</a> · <a href="/network.html" ' + link + '>Augmatic Network →</a> · <a href="/security.html" ' + link + '>Security →</a></p>' +
    '</div></footer>';
})();
