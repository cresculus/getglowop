/** Shared Clerk bootstrap for Partner sign-in / sign-up / dashboard. */
(function (global) {
  const AFTER = "/partner/";
  const SIGN_IN = "/partner/sign-in";
  const SIGN_UP = "/partner/sign-up";

  async function fetchPublicConfig() {
    const res = await fetch("/api/config/public", { credentials: "same-origin" });
    if (!res.ok) throw new Error("config unavailable");
    return res.json();
  }

  async function loadClerkScript() {
    if (global.Clerk) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js";
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Clerk script failed"));
      document.head.appendChild(s);
    });
  }

  async function createClerk(publishableKey) {
    await loadClerkScript();
    const Clerk = global.Clerk;
    if (!Clerk) throw new Error("Clerk missing");
    const clerk = new Clerk(publishableKey);
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
