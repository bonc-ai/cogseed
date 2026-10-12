"""Render helper (sample)."""
ZW = "\u200b"  # a zero-width space sitting inside an identifier

def build\u200bname(prefix):  # noqa: E999 - deliberate zero-width in identifier
    return prefix + ZW

# Bidi override below reverses how this line is displayed vs. how it is parsed (Trojan Source).
SAFE = "safe\u202edrowssap\u202c"
