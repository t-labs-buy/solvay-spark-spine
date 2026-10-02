"""Password hashing, with the standard library's scrypt.

scrypt rather than bcrypt or argon2 because it is in hashlib and needs no new
dependency, and it is memory-hard, which is what makes a stolen table slow to
guess against. The stored form names its parameters, so they can be raised
later without invalidating every existing password:

    scrypt$<n>$<r>$<p>$<salt hex>$<hash hex>
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

N, R, P = 2**14, 8, 1
DKLEN = 32

# A password this short is refused when it is set, not when it is checked:
# an existing account must still be able to sign in after the rule changes.
MIN_LENGTH = 8


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=N, r=R, p=P, dklen=DKLEN)
    return f"scrypt${N}${R}${P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """False for a wrong password and for anything that is not a hash -- the
    legacy account's empty string, a truncated value -- rather than raising."""
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = bytes.fromhex(digest)
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt),
                             n=int(n), r=int(r), p=int(p), dklen=len(expected))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got, expected)


# Checked against when the username does not exist, so a wrong username costs
# the same scrypt as a wrong password and the timing does not say which it was.
DUMMY_HASH = hash_password(secrets.token_hex(16))


def check_strength(password: str) -> str | None:
    """Why a new password is refused, or None."""
    if len(password) < MIN_LENGTH:
        return f"A password needs at least {MIN_LENGTH} characters."
    return None
