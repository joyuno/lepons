"""Writes send.wav: the chat's send sound, computed here from sine waves and no recording.

A soft rise, 620 to 930 Hz, in 0.14 s. Run: python make-send.py
"""
import math
import pathlib
import struct
import wave

RATE = 44100
LENGTH = 0.14
PEAK = 10 ** (-15 / 20)  # well under a notification

samples = []
phase = 0.0
for i in range(int(RATE * LENGTH)):
    t = i / RATE
    rise = min(t / 0.06, 1.0)
    phase += 2 * math.pi * 620 * (1.5 ** rise) / RATE
    tone = math.sin(phase) + 0.18 * math.sin(2 * phase)
    shape = (1 - math.exp(-t / 0.003)) * math.exp(-t / 0.035) * min((LENGTH - t) / 0.005, 1.0)
    samples.append(tone * shape)

top = max(abs(s) for s in samples)
with wave.open(str(pathlib.Path(__file__).with_name("send.wav")), "wb") as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(RATE)
    out.writeframes(b"".join(struct.pack("<h", round(s / top * PEAK * 32767)) for s in samples))
