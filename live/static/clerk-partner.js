/** Shared Clerk bootstrap for Partner sign-in / sign-up / dashboard. */
(function (global) {
  const AFTER = "/partner/";
  const SIGN_IN = "/partner/sign-in";
  const SIGN_UP = "/partner/sign-up";
  const SSO_CB = "/partner/sso-callback";

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
      document.querySelectorAll("script[data-glow-clerk]").forEach((el) => el.remove());
      const s = document.createElement("script");
      s.async = true;
      s.crossOrigin = "anonymous";
      s.src = src;
      s.dataset.glowClerk = "1";
      s.setAttribute("data-clerk-publishable-key", pk);
      s.onload = () => resolve(s);
      s.onerror = () => reject(new Error("script failed: " + src));
      document.head.appendChild(s);
    });
  }

  async function loadClerkScript(pk) {
    if (global.Clerk && typeof global.Clerk.load === "function" && typeof global.Clerk.mountSignIn === "function") {
      return;
    }
    if (typeof global.Clerk === "function") return;

    const host = frontendHostFromPk(pk);
    const urls = [
      host ? host + "/npm/@clerk/clerk-js@5/dist/clerk.browser.js" : null,
      "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js",
    ].filter(Boolean);

    let lastErr = null;
    for (const src of urls) {
      try {
        await loadScriptTag(src, pk);
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
    if (!C) throw new Error("Clerk global missing after script load");

    if (typeof C.load === "function" && typeof C.mountSignIn === "function") {
      await C.load();
      global.__glowClerk = C;
      return C;
    }
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

  function glowAppearance() {
    return {
      layout: {
        socialButtonsPlacement: "top",
        socialButtonsVariant: "blockButton",
        showOptionalFields: false,
      },
      variables: {
        colorPrimary: "#0d130b",
        colorBackground: "#ffffff",
        colorInputBackground: "#edf1e8",
        colorInputText: "#0d130b",
        colorText: "#0d130b",
        colorTextSecondary: "#39422f",
        colorDanger: "#c43c2c",
        borderRadius: "0px",
        fontFamily: '"Archivo", system-ui, sans-serif',
        fontFamilyButtons: '"Archivo", system-ui, sans-serif',
        fontWeight: { normal: 600, medium: 700, bold: 800 },
      },
      elements: {
        rootBox: { width: "100%" },
        card: {
          boxShadow: "none",
          border: "2px solid #0d130b",
          borderRadius: "0",
          padding: "1rem 1rem 0.85rem",
        },
        headerTitle: {
          fontSize: "1.15rem",
          fontWeight: "900",
          textTransform: "uppercase",
          letterSpacing: "-0.02em",
        },
        headerSubtitle: { display: "none" },
        socialButtonsBlockButton: {
          border: "2px solid #0d130b",
          borderRadius: "0",
          boxShadow: "2px 2px 0 #0d130b",
          fontWeight: "800",
        },
        formFieldInput: {
          border: "2px solid #0d130b",
          borderRadius: "0",
          minHeight: "40px",
          boxShadow: "none",
        },
        formButtonPrimary: {
          backgroundColor: "#bff747",
          color: "#0d130b",
          border: "2px solid #0d130b",
          borderRadius: "0",
          boxShadow: "3px 3px 0 #0d130b",
          fontWeight: "900",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          minHeight: "42px",
        },
        footerActionLink: { color: "#0d130b", fontWeight: "800" },
        dividerLine: { background: "#0d130b" },
        dividerText: {
          color: "#39422f",
          fontFamily: '"IBM Plex Mono", monospace',
          fontSize: "0.65rem",
        },
      },
    };
  }

  function mountOpts(extra) {
    return Object.assign(
      {
        forceRedirectUrl: AFTER,
        fallbackRedirectUrl: AFTER,
        appearance: glowAppearance(),
      },
      extra || {}
    );
  }

  function mountSignIn(clerk, el) {
    clerk.mountSignIn(
      el,
      mountOpts({
        routing: "path",
        path: SIGN_IN,
        signUpUrl: SIGN_UP,
      })
    );
  }

  function mountSignUp(clerk, el) {
    clerk.mountSignUp(
      el,
      mountOpts({
        routing: "path",
        path: SIGN_UP,
        signInUrl: SIGN_IN,
      })
    );
  }

  /** Prefer redirect over popup for Google/Microsoft (popups often look like a no-op). */
  async function oauthRedirect(clerk, strategy) {
    const origin = window.location.origin;
    if (typeof clerk.authenticateWithRedirect === "function") {
      await clerk.authenticateWithRedirect({
        strategy,
        redirectUrl: origin + SSO_CB,
        redirectUrlComplete: origin + AFTER,
      });
      return;
    }
    // Fallback: navigate to dedicated sign-in (Clerk social buttons)
    window.location.href = SIGN_IN;
  }

  global.GlowClerkPartner = {
    AFTER,
    SIGN_IN,
    SIGN_UP,
    SSO_CB,
    fetchPublicConfig,
    createClerk,
    sessionToken,
    mountSignIn,
    mountSignUp,
    oauthRedirect,
  };
})(window);
