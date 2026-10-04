#!/usr/bin/env python3
"""Render a deterministic 15-second, loop-friendly instrumental bed with stdlib only."""

import math
import random
import struct
import wave
from pathlib import Path


SAMPLE_RATE = 44_100
DURATION_SECONDS = 15
TOTAL_FRAMES = SAMPLE_RATE * DURATION_SECONDS
BEATS_PER_MINUTE = 96
BEAT_SECONDS = 60 / BEATS_PER_MINUTE
BAR_SECONDS = BEAT_SECONDS * 4
OUT_PATH = Path(__file__).resolve().parents[1] / "public" / "audio" / "bg_music.wav"

left = [0.0] * TOTAL_FRAMES
right = [0.0] * TOTAL_FRAMES
rng = random.Random(20261004)


def midi_to_hz(note: int) -> float:
    return 440.0 * (2 ** ((note - 69) / 12))


def add_tone(start: float, duration: float, note: int, volume: float, pan: float, kind: str):
    start_frame = max(0, int(start * SAMPLE_RATE))
    end_frame = min(TOTAL_FRAMES, int((start + duration) * SAMPLE_RATE))
    frequency = midi_to_hz(note)
    pan_left = math.sqrt((1 - pan) * 0.5)
    pan_right = math.sqrt((1 + pan) * 0.5)
    phase_offset = rng.random() * math.tau
    for frame in range(start_frame, end_frame):
        t = (frame - start_frame) / SAMPLE_RATE
        if kind == "pad":
            attack = min(1.0, t / 0.24)
            release = min(1.0, max(0.0, (duration - t) / 0.36))
            envelope = min(attack, release) * 0.84
            sample = (
                math.sin(math.tau * frequency * t + phase_offset) * 0.78
                + math.sin(math.tau * frequency * 2 * t + phase_offset * 0.5) * 0.13
            )
        elif kind == "bass":
            envelope = (1 - math.exp(-t * 100)) * math.exp(-t * 4.2)
            sample = (
                math.sin(math.tau * frequency * t + phase_offset) * 0.82
                + math.sin(math.tau * frequency * 2 * t + phase_offset) * 0.18
            )
        else:  # short, rounded marimba-like pluck
            envelope = (1 - math.exp(-t * 75)) * math.exp(-t * 12.5)
            sample = (
                math.sin(math.tau * frequency * t + phase_offset) * 0.73
                + math.sin(math.tau * frequency * 2.72 * t + phase_offset) * 0.2
                + math.sin(math.tau * frequency * 4.03 * t + phase_offset * 0.4) * 0.07
            )
        value = volume * envelope * sample
        left[frame] += value * pan_left
        right[frame] += value * pan_right


def add_kick(start: float, volume: float = 0.24):
    start_frame = max(0, int(start * SAMPLE_RATE))
    end_frame = min(TOTAL_FRAMES, start_frame + int(0.24 * SAMPLE_RATE))
    for frame in range(start_frame, end_frame):
        t = (frame - start_frame) / SAMPLE_RATE
        phase = math.tau * (70 * t - 16 * t * t / 0.24)
        envelope = (1 - math.exp(-t * 130)) * math.exp(-t * 16)
        value = volume * envelope * math.sin(phase)
        left[frame] += value * 0.72
        right[frame] += value * 0.72


def add_hand_percussion(start: float, volume: float = 0.065, duration: float = 0.12):
    start_frame = max(0, int(start * SAMPLE_RATE))
    end_frame = min(TOTAL_FRAMES, start_frame + int(duration * SAMPLE_RATE))
    previous = 0.0
    pan = rng.uniform(-0.65, 0.65)
    pan_left = math.sqrt((1 - pan) * 0.5)
    pan_right = math.sqrt((1 + pan) * 0.5)
    for frame in range(start_frame, end_frame):
        t = (frame - start_frame) / SAMPLE_RATE
        noise = rng.uniform(-1.0, 1.0)
        high_passed = noise - previous * 0.74
        previous = noise
        envelope = math.exp(-t * (26 if duration > 0.08 else 95))
        value = volume * envelope * high_passed
        left[frame] += value * pan_left
        right[frame] += value * pan_right


# Six four-beat bars resolve the complete 15-second runtime.
chords = [
    [60, 64, 67, 71],  # Cmaj7
    [57, 60, 64, 67],  # Am7
    [53, 57, 60, 64],  # Fmaj7
    [55, 59, 62, 65],  # G7
    [60, 64, 67, 71],  # Cmaj7
    [55, 59, 62, 65],  # G7, leading back to C
]
melody = [
    [67, 72, 74, 76, 72, 67, 64, 67],
    [69, 72, 76, 79, 76, 72, 69, 67],
    [69, 72, 76, 77, 76, 72, 69, 67],
    [67, 71, 74, 77, 74, 71, 67, 69],
    [67, 72, 76, 79, 76, 72, 67, 64],
    [67, 71, 74, 77, 74, 71, 67, 64],
]

for bar, chord in enumerate(chords):
    bar_start = bar * BAR_SECONDS
    for voice, note in enumerate(chord):
        add_tone(
            bar_start,
            BAR_SECONDS + 0.42,
            note,
            0.047 if voice < 3 else 0.027,
            (-0.48, -0.16, 0.16, 0.48)[voice],
            "pad",
        )

    for beat in (0, 2):
        beat_start = bar_start + beat * BEAT_SECONDS
        add_kick(beat_start, 0.2 if beat == 0 else 0.15)
        add_tone(beat_start, 0.38, chord[0] - 12, 0.18, 0, "bass")

    for beat in (1, 3):
        add_hand_percussion(bar_start + beat * BEAT_SECONDS, 0.052, 0.1)

    for eighth in range(8):
        onset = bar_start + eighth * BEAT_SECONDS / 2
        note = melody[bar][eighth]
        add_tone(onset, 0.23, note, 0.075 if eighth in (0, 4) else 0.055, -0.16 if eighth % 2 else 0.16, "pluck")
        if eighth % 2 == 1:
            add_hand_percussion(onset, 0.021, 0.035)

# Blend the ending into the opening so the ad's 15-second loop does not click.
crossfade_frames = int(0.72 * SAMPLE_RATE)
for offset in range(crossfade_frames):
    progress = offset / max(1, crossfade_frames - 1)
    tail_weight = math.cos(progress * math.pi / 2)
    head_weight = math.sin(progress * math.pi / 2)
    tail_frame = TOTAL_FRAMES - crossfade_frames + offset
    left[tail_frame] = left[tail_frame] * tail_weight + left[offset] * head_weight
    right[tail_frame] = right[tail_frame] * tail_weight + right[offset] * head_weight

peak = max(max(abs(sample) for sample in left), max(abs(sample) for sample in right), 1e-9)
gain = min(1.0, 0.78 / peak)

OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(OUT_PATH), "wb") as output:
    output.setnchannels(2)
    output.setsampwidth(2)
    output.setframerate(SAMPLE_RATE)
    frames = bytearray()
    for l_sample, r_sample in zip(left, right):
        frames.extend(
            struct.pack(
                "<hh",
                max(-32768, min(32767, round(l_sample * gain * 32767))),
                max(-32768, min(32767, round(r_sample * gain * 32767))),
            )
        )
    output.writeframes(frames)

print(f"Rendered {DURATION_SECONDS}s stereo instrumental: {OUT_PATH}")