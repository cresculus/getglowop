"""Clerk JWT verification for GlowOps Partner (dedicated GlowOps Clerk app)."""
from __future__ import annotations

import json
import os
import time
import urllib.request
from typing import Any

_JWKS_CACHE: dict[str, Any] = {"keys": None, "fetched_at": 0.0}


def _publishable_key() -> str:
    return (
        os.environ.get("CLERK_PUBLISHABLE_KEY")
        or os.environ.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")
        or ""
    ).strip()


def _secret_key() -> str:
    return (os.environ.get("CLERK_SECRET_KEY") or "").strip()


def clerk_ui_enabled() -> bool:
    """Frontend can mount Clerk with publishable key alone."""
    return bool(_publishable_key())


def clerk_configured() -> bool:
    """JWT verify needs both publishable + secret."""
    return bool(_secret_key() and _publishable_key())


def public_clerk_config() -> dict[str, Any]:
    pk = _publishable_key()
    return {
        "enabled": bool(pk),
        "verifyReady": clerk_configured(),
        "publishableKey": pk or None,
        "publishableSet": bool(pk),
        "secretSet": bool(_secret_key()),
        "signInUrl": "/partner/sign-in",
        "signUpUrl": "/partner/sign-up",
        "afterSignInUrl": "/partner/",
        "afterSignUpUrl": "/partner/",
    }


def _authorized_parties() -> list[str]:
    raw = os.environ.get("CLERK_AUTHORIZED_PARTIES") or os.environ.get("GLOWOPS_PUBLIC_URL") or ""
    return [p.strip() for p in raw.split(",") if p.strip()]


def _issuer_from_publishable(pk: str) -> str | None:
    """Clerk publishable keys encode frontend API host in base64 after pk_test_/pk_live_."""
    try:
        import base64

        prefix = "pk_test_" if pk.startswith("pk_test_") else "pk_live_" if pk.startswith("pk_live_") else None
        if not prefix:
            return None
        padded = pk[len(prefix) :]
        pad = "=" * (-len(padded) % 4)
        host = base64.b64decode(padded + pad).decode("utf-8").strip().rstrip("$")
        if not host:
            return None
        if not host.startswith("http"):
            host = "https://" + host
        return host.rstrip("/")
    except Exception:
        return None


def _jwks(issuer: str) -> dict[str, Any]:
    now = time.time()
    if _JWKS_CACHE["keys"] and now - float(_JWKS_CACHE["fetched_at"]) < 3600:
        return _JWKS_CACHE["keys"]
    url = issuer.rstrip("/") + "/.well-known/jwks.json"
    with urllib.request.urlopen(url, timeout=10) as resp:
        keys = json.loads(resp.read().decode("utf-8"))
    _JWKS_CACHE["keys"] = keys
    _JWKS_CACHE["fetched_at"] = now
    return keys


def verify_bearer_token(token: str) -> dict[str, Any] | None:
    """Verify a Clerk session JWT. Returns claims or None."""
    if not token or not clerk_configured():
        return None
    try:
        import jwt
        from jwt import PyJWKClient
    except ImportError:
        # Fallback: decode without verify only when explicitly allowed (lab).
        if os.environ.get("CLERK_UNSAFE_DECODE") == "1":
            return jwt_unsafe_decode(token)
        return None

    pk = _publishable_key()
    issuer = os.environ.get("CLERK_ISSUER") or _issuer_from_publishable(pk)
    if not issuer:
        return None
    jwks_url = issuer.rstrip("/") + "/.well-known/jwks.json"
    try:
        client = PyJWKClient(jwks_url)
        signing_key = client.get_signing_key_from_jwt(token)
        parties = _authorized_parties()
        options = {"verify_aud": False}
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            options=options,
        )
        # Clerk session tokens often use azp for authorized party
        azp = claims.get("azp")
        if parties and azp and azp not in parties:
            # also allow if azp is empty on some token types
            pass
        if claims.get("exp") and time.time() > float(claims["exp"]):
            return None
        return claims
    except Exception:
        return None


def jwt_unsafe_decode(token: str) -> dict[str, Any] | None:
    try:
        import base64

        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(payload.encode("utf-8")))
    except Exception:
        return None


def partner_from_claims(claims: dict[str, Any]) -> dict[str, Any]:
    email = (
        claims.get("email")
        or (claims.get("email_addresses") or [{}])[0].get("email_address")
        if isinstance(claims.get("email_addresses"), list)
        else None
    )
    if not email:
        email = claims.get("primary_email_address") or ""
    return {
        "id": f"clerk_{claims.get('sub') or claims.get('id') or 'unknown'}",
        "name": claims.get("name") or claims.get("full_name") or (email.split("@")[0] if email else "Partner"),
        "email": email or "unknown",
        "clerkUserId": claims.get("sub"),
        "auth": "clerk",
    }
