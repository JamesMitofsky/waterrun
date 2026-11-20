"""Scores the film from its own event list: a water drop for each fountain as
the loop reaches it, soft air for each screen change, a tap, a rubber stamp,
and a closing chime, over a quiet two-note bed. Pure synthesis (numpy), so
there is no music licence to clear.

    python3 scripts/score.py out.wav <seconds> '<events json>'
"""
import json, sys, wave
import numpy as np

SR = 48000
out, dur, events = sys.argv[1], float(sys.argv[2]), json.loads(sys.argv[3])
n = int(dur * SR)
L = np.zeros(n); R = np.zeros(n)
rng = np.random.default_rng(7)
t_all = np.arange(n) / SR

def add(sig, at, pan=0.0, gain=1.0):
    i = int(at * SR)
    j = min(n, i + len(sig))
    if i >= n: return
    l = np.cos((pan + 1) * np.pi / 4); r = np.sin((pan + 1) * np.pi / 4)
    L[i:j] += sig[: j - i] * gain * l
    R[i:j] += sig[: j - i] * gain * r

def env(length, attack, decay):
    t = np.arange(int(length * SR)) / SR
    return np.minimum(1, t / max(attack, 1e-4)) * np.exp(-t / decay), t

def drop(pitch):
    e, t = env(0.35, 0.002, 0.07)
    f = pitch * (1 + 1.4 * np.exp(-t / 0.018))  # the "plip" of a falling drop
    ph = 2 * np.pi * np.cumsum(f) / SR
    return (np.sin(ph) + 0.25 * np.sin(2 * ph)) * e

def whoosh():
    e, t = env(0.45, 0.12, 0.12)
    noise = rng.standard_normal(len(t))
    k = np.exp(-np.linspace(0, 6, 64)); k /= k.sum()
    return np.convolve(noise, k, "same") * e * 0.6

def tap():
    e, t = env(0.08, 0.0005, 0.012)
    return (np.sin(2 * np.pi * 1900 * t) * 0.5 + rng.standard_normal(len(t)) * 0.3) * e

def stamp():
    e, t = env(0.3, 0.001, 0.05)
    body = np.sin(2 * np.pi * 95 * t * (1 + 0.6 * np.exp(-t / 0.02)))
    click = rng.standard_normal(len(t)) * np.exp(-t / 0.008)
    return (body + 0.5 * click) * e

def chime():
    out = np.zeros(int(2.2 * SR))
    for f, a in [(523.25, 1), (783.99, 0.6), (1046.5, 0.35)]:
        e, t = env(2.2, 0.005, 0.7)
        out += np.sin(2 * np.pi * f * t) * e * a
    return out

drops = [e for e in events if e["type"] == "drop"]
scale = [880, 987.8, 1108.7, 1318.5, 1480, 1661.2, 1760, 1975.5, 2217.5]
for k, e in enumerate(sorted(drops, key=lambda e: e["t"])):
    add(drop(scale[k % len(scale)]), e["t"], pan=-0.5 + k / max(1, len(drops) - 1), gain=0.32)
for e in events:
    f = {"whoosh": (whoosh, 0.18), "sheet": (whoosh, 0.12), "tap": (tap, 0.35), "stamp": (stamp, 0.6), "chime": (chime, 0.22)}.get(e["type"])
    if f: add(f[0](), e["t"], gain=f[1])

# The bed: two soft tones, slow swell, in and out with the film.
bed = (np.sin(2 * np.pi * 220 * t_all) + 0.7 * np.sin(2 * np.pi * 329.63 * t_all)) * (0.5 + 0.5 * np.sin(2 * np.pi * 0.11 * t_all))
fade = np.minimum(1, t_all / 2.5) * np.minimum(1, (dur - t_all) / 2.0)
L += bed * fade * 0.025; R += bed * fade * 0.025 * 0.9

mix = np.stack([L, R], 1)
mix *= 0.89 / max(1e-9, np.abs(mix).max())  # peak about -1 dBFS
with wave.open(out, "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())
print(f"score: {dur}s, {len(events)} cues -> {out}")
