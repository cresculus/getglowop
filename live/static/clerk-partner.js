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
    const res = await fetch("/api/config/public?v=" + Date.now(), {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) throw new Error("config unavailable");
    return res.json();
  }

  function loadScriptTag(src, pk) {
    return new Promise((resolve, reject) => {
      // Remove any prior failed clerk script tags
      document.querySelectorAll("script[data-glow-clerk]").forEach((el) => el.remove());
      const s = document.createElement("script");
      s.async = true;
      s.crossOrigin = "anonymous";
      s.src = src;
      s.dataset.glowClerk = "1";
      // Required when loading from *.clerk.accounts.dev — script auto-inits
      s.setAttribute("data-clerk-publishable-key", pk);
      s.onload = () => resolve(s);
      s.onerror = () => reject(new Error("script failed: " + src));
      document.head.appendChild(s);
    });
  }

  async function loadClerkScript(pk) {
    // Already have a usable instance
    if (global.Clerk && typeof global.Clerk.load === "function" && typeof global.Clerk.mountSignIn === "function") {
      return;
    }
    // Already have a constructor
    if (typeof global.Clerk === "function") {
      return;
    }

    const host = frontendHostFromPk(pk);
    const urls = [
      host ? host + "/npm/@clerk/clerk-js@5/dist/clerk.browser.js" : null,
      "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js",
    ].filter(Boolean);

    let lastErr = null;
    for (const src of urls) {
      try {
        await loadScriptTag(src, pk);
        // Give the UMD a tick to attach
        await new Promise((r) => setTimeout(r, 0));
        if (global.Clerk) return;
        lastErr = new Error("Clerk global missing after " + src);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Clerk script failed to load");
  }

  async function createClerk(publishableKey) {
    const pk = cleanKey(publishableKey);
    if (!pk || !pk.startsWith("pk_")) {
      throw new Error("Missing publishableKey from /api/config/public");
    }
    await loadClerkScript(pk);

    const C = global.Clerk;
    if (!C) {
      throw new Error("Clerk global missing after script load");
    }

    // FAPI / data-clerk-publishable-key style: window.Clerk is already an instance
    if (typeof C.load === "function" && typeof C.mountSignIn === "function") {
      await C.load();
      global.__glowClerk = C;
      return C;
    }

    // Older/UMD constructor style: window.Clerk is a class
    if (typeof C === "function") {
      const clerk = new C(pk);
      await clerk.load();
      global.__glowClerk = clerk;
      return clerk;
    }

    throw new Error("Unexpected Clerk global shape: " + typeof C);
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
