# Fit-Gap Copilot demo video

A narrated walk-through (about 6½ minutes) of the Fit-Gap Copilot's output for the India customer returns run (`ro_879e0497a4`), built for the Solvay meeting. The slides, the Knowledge Graph and starting a run stay live. This video covers the part that is too dense to narrate on the spot: what the Copilot produced.

| File | What it is |
|---|---|
| `fitgap-demo-rough.mp4` | Screen recordings with burned-in captions, title/closing cards and a voice-over by Kokoro-82M, an open-source TTS model (voice `af_heart`). |
| `script.md` | Timed narration, one section per scene: screen, caption, voice-over. |
| `scenes.json` | Single source for the story: captions, voice-over, cue phrases, cards, pronunciation rules, masks. |
| `captures/` | 1920×1080 stills of every key state, for slides or a re-edit. |
| `scenes.py` | One function per app scene: what happens on screen at each cue phrase. |
| `tools/` | The `demo-video` skill's engine (`~/.claude/skills/demo-video`), vendored here. Refresh with `python3 ~/.claude/skills/demo-video/engine/init.py docs/demo-video`. |

## What the video has to do (from the prep meetings)

Sanjeev's brief from the two prep meetings:

1. **Tell it as a story.** "Weeks before the India rollout, we have the country's As-Is for one sub-process." Say plainly that the India document is **synthetic and AI-generated**; Solvay did not provide it.
2. **Gaps first, not the workshop.** The first view is the deviations the Copilot found. The agenda comes after.
3. **Headline numbers, worded correctly:**
   - 51.3% aligned to the Global Template, which is **48.7% divergence**. It is not "51% deviation".
   - 53.8% aligned to SAP Best Practice.
   - 58.4% harmonization potential.
   - 15 deviations, of which 11 must be discussed, in 255 minutes.
4. **Computed, not generated.** The scores come from rated, weighted dimensions (the formula tooltip). The comparison is against the reconstructed process in Solvay's process knowledge graph, not a keyword or similarity search.
5. **One gap end to end** (GAP-IN-RET-01, approvals): the three-way comparison, the impact, the proposed route, the options, the evidence and the recorded outcome.
6. **The three routes:** adopt the template, move to SAP standard, or keep a local exception. Show them in one view (Risk view) instead of jumping between tabs.
7. **The Global Template is itself unique.** SAP scores above it, which is why Solvay's own process knowledge graph must be the reference, not SAP's.
8. **The value close:** weeks of localization workshops become hours of decisions; it runs asynchronously for every rollout country without touching the go-live.

## The voice-over

The narration is spoken by **Kokoro-82M**, an open-source text-to-speech model (Apache 2.0, so commercial use is fine), with the voice `af_heart`. It runs locally; nothing is sent to a service.

Each scene's voice-over is split at its **cue phrases**, so the moment each phrase is spoken is known. `tools/record.py` waits for those moments before acting:
- each card is pointed at as its number is read;
- the tooltip opens on "Hover the score";
- the inspector scrolls to Evidence on "Every claim is quoted".

The picture and the words stay in step at normal speed.

**Pronunciation** is set in `scenes.json` `pronounce.kokoro`. The on-screen text is unchanged.
- GAP-IN-RET-01 is read as "gap 1".
- SAP is written "S-A-P"; otherwise it is said as the word "sap".
- L2C is written "L-2-C".
- **Solvay and Solvay's** have phonetic spellings. Kokoro doesn't know the name and silently dropped it. Until 1 Oct 2026 the video said "s" for "Solvay's".
- **watchlist** and **workstream** are split into two words, because Kokoro dropped them.
- **go-live** and **low-risk** are split, because Kokoro slurred them.

`tools/check.py` transcribes the narration with Whisper and lists every word that differs from the script and every word Kokoro can't pronounce. The only remaining difference is "bands" heard as "bans", a soft final "d".

**Setup, once per machine** (about 1.5 GB, in `~/.cache/demo-video-tts`):

```bash
bash docs/demo-video/tools/setup_tts.sh
```

**Changing the voice.** The timings follow the voice, so re-record, then build:

```bash
export VOICE=bf_emma        # af_heart (default), af_bella, am_michael, bf_emma, bm_george, …
export VOICE_SPEED=0.95     # Kokoro pace, default 1.0
python3 docs/demo-video/tools/record.py && python3 docs/demo-video/tools/build.py
```

Samples of five voices are in `clips/voice-samples/`. They predate the Solvay pronunciation fix.

Other routes:
- `TTS=say VOICE=Daniel` uses the macOS voice.
- `VOICE=` builds a silent cut.
- For a human voice, record over the MP4 with QuickTime, reading `script.md`.

## Regenerating

```bash
# App running on http://localhost:8000; the recording signs in with the account in DEMO_USERNAME / DEMO_PASSWORD.
python3 docs/demo-video/tools/voice.py             # narration + cue times (cached), ~1 min first time
python3 docs/demo-video/tools/record.py            # all scenes, ~7 min; or name scenes: s05_gap01
python3 docs/demo-video/tools/build.py             # narrated MP4 + script.md, ~45 s
python3 docs/demo-video/tools/check.py             # transcript diff, late cues, contact sheets, leaks
```

- **Captions only changed:** re-run `build.py`.
- **Voice-over, cues, voice or pronunciation changed:** re-record the affected scenes, then build. `build.py` refuses recordings made against a different voice-over.
- **Cue phrases** must appear in the voice-over, in order. To add an action, add its phrase to `cues` and an `at("phrase")` in that scene's function in `scenes.py`.

## Things to know

- **Nothing was written to the database.** All 15 decisions in this run were already recorded ("15 of 15 decided"). Facilitator mode is only opened and hovered; no Accept, Defer, Reject or Submit is ever clicked.
- **Demo Mode does not hide the model name on the Traceability tab.** It shows `model claude-opus-5 · prompt … · corpus …`. The recorder strips it from the page before filming. In the live demo, avoid Traceability or fix it in the app.
- **The recorded outcomes differ from the Copilot's first proposal in places.** For example, on GAP-IN-RET-11 the room chose option B (interface to the existing India compliance service). The script quotes what the screen shows.
- **Not in the video:**
  - Dimensions, Backlog (0), Country As-Is model, Quality gates (0 hard, 0 soft) and Evaluation. These can be shown live if asked.
  - The India As-Is diagram, removed on request.
  - An SAP-standard process diagram. None exists in the repo.
- **The 50–60% / 30–40% workshop-time savings are estimates from the prep meeting**, not measurements. The closing card says "weeks → hours" and nothing more precise. The real baseline comes from the first rollout.
