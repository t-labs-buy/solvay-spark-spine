# Demo video

<!-- One paragraph: what the video shows, for whom, what stays live in the meeting. -->

| File | What it is |
|---|---|
| `demo-video.mp4` | The narrated, captioned video (gitignored; rebuild with the commands below). |
| `script.md` | Timed narration, one section per scene. Generated; edit `scenes.json` instead. |
| `scenes.json` | The story: scenes, captions, voice-over, cue phrases, cards, pronunciation, masks. |
| `scenes.py` | One function per app scene: what happens on screen at each cue. |
| `captures/` | Full-resolution stills of key moments, for slides. |
| `tools/` | The demo-video engine (from the `demo-video` skill; refresh with its `init.py`). |

## Regenerating

```bash
bash tools/setup_tts.sh          # once per machine: local Kokoro voice + Whisper
python3 tools/voice.py           # narration + cue times (cached)
python3 tools/record.py          # screen recordings timed to the narration; or name scenes
python3 tools/build.py           # MP4 + script.md
python3 tools/check.py           # transcript diff, late cues, contact sheets, leaks
```

- **Caption or card change:** run `build.py` only.
- **Voice-over, cues or voice change:** re-record the affected scenes, then build.

## The voice

Kokoro-82M (open source, Apache 2.0) runs locally; nothing is sent to a service.

- **Other voices:** `VOICE=bf_emma` / `am_michael` / `bm_george`.
- **Pace:** `VOICE_SPEED=0.95`.
- **macOS voice:** `TTS=say VOICE=Daniel`.
- **Silent cut:** `VOICE=`.

After changing any of these, re-record, then build.

## Things to know

- **Script:** follows `docs/fitgap-demo-video-script.md`. Recorded against https://solvay-sparkai.ivolve.cloud/demo as a regular (non-Admin) user.
- **Credentials:** read from `DEMO_USERNAME` / `DEMO_PASSWORD`; never stored in these files. The username is drawn as dots on the sign-in page.
- **Data written (approved by the user):** `s04_fitgap` uploads `~/Desktop/India_Customer_Returns_As_Is.txt`, starts a real run and stops it. Each recording of that scene leaves one interrupted run in the account's History, and the agent's first pass keeps calling Claude on the server for a minute or two after Stop. The upload is temporary (swept after 12 hours). Five takes were recorded, so five interrupted India runs are in History.
- **Past run:** steps 7b and 8 load the finished run whose History card shows `GT 58.8%` (4.10.2 Process Returns, ro_6453bba46e). If it is deleted, change `RUN_CARD` in `scenes.py`.
- **Masked:** the *Deciding as* field (holds the signed-in user's e-mail) is hidden with CSS; model names are in `mask`.
- **Synthetic:** the India customer returns As-Is document is synthetic; the title card says so.
- **Upload stages:** a `.txt` file skips Docling, so the screen shows *chunking and embedding* → *extracting entities* only. Processing takes about 26 s; it overlaps the narration.
- **Not shown:** the file picker (headless browser) and the browser address bar; the caption carries the URL instead.
