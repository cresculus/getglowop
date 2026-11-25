/** Shared Clerk bootstrap for Partner sign-in / sign-up / dashboard. */
(function (global) {
  const AFTER = "/partner/";
  const SIGN_IN = "/partner/sign-in";
  const SIGN_UP = "/partner/sign-up";

  function cleanKey(pk) {
    return String(pk || "")
      .trim()
      .replace(/^["']|["']$/g, "");
  }

  function frontendHostFromPk(pk) {
    try {
      const raw = pk.replace(/^pk_test_/, "").replace(/^pk_live_/, "");
      const pad = "=".repeat((4 - (raw.length % 4)) % 4);
      let host = atob(raw + pad).replace(/\$$/, "").trim();
      if (!host) return null;
      if (!/^https?:/i.test(host)) host = "https://" + host;
      return host.replace(/\/$/, "");
    } catch (_) {
      return null;
    }
  }

  async function fetchPublicConfig() {
    const res = await fetch("/api/config/public?v=" + Date.now(), { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) throw new Error("config unavailable");
    return res.json();
  }

  async function loadClerkScript(pk) {
    if (global.Clerk && typeof global.Clerk === "function") return;
    const host = frontendHostFromPk(pk);
    const urls = [
      host ? host + "/npm/@clerk/clerk-js@5/dist/clerk.browser.js" : null,
      "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js",
    ].filter(Boolean);

    let lastErr = null;
    for (const src of urls) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = src;
          s.async = true;
          s.crossOrigin = "anonymous";
          s.onload = resolve;
          s.onerror = () => reject(new Error("blocked or failed: " + src));
          document.head.appendChild(s);
        });
        if (global.Clerk) return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Clerk script blocked — disable ad blocker for getglowop.com");
  }

  async function createClerk(publishableKey) {
    const pk = cleanKey(publishableKey);
    if (!pk || !pk.startsWith("pk_")) {
      throw new Error("Missing publishableKey from /api/config/public");
    }
    await loadClerkScript(pk);
    const ClerkCtor = global.Clerk;
    if (!ClerkCtor) {
      throw new Error("Clerk missing — ad blocker may be blocking clerk-js. Allow getglowop.com and *.clerk.accounts.dev");
    }
    const clerk = new ClerkCtor(pk);
    await clerk.load();
    global.__glowClerk = clerk;
    return clerk;
  }

  async function sessionToken(clerk) {
    if (!clerk?.session) return null;
    return clerk.session.getToken();
  }

  async function partnerMe(token) {
    const res = await fetch("/api/partner/me", {
      credentials: "same-origin",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.partner || null;
  }

  function mountSignIn(clerk, el) {
    clerk.mountSignIn(el, {
      routing: "hash",
      signUpUrl: SIGN_UP,
      afterSignInUrl: AFTER,
      afterSignUpUrl: AFTER,
    });
  }

  function mountSignUp(clerk, el) {
    clerk.mountSignUp(el, {
      routing: "hash",
      signInUrl: SIGN_IN,
      afterSignInUrl: AFTER,
      afterSignUpUrl: AFTER,
    });
  }

  global.GlowClerkPartner = {
    AFTER,
    SIGN_IN,
    SIGN_UP,
    fetchPublicConfig,
    createClerk,
    sessionToken,
    partnerMe,
    mountSignIn,
    mountSignUp,
  };
})(window);
