# Clicky — End-to-End Knowledge Base

_Compiled 2026-10-07 from the public repo (github.com/farzaa/clicky), its AGENTS.md, worker source, and launch coverage._

## 1. What it is
- **Clicky** = an AI teacher/buddy for macOS that lives **next to your cursor**. It **sees your screen**, **listens to your voice**, **talks back**, and **points at UI elements** with an animated blue cursor.
- Use case: step-by-step guidance inside any app (Figma, DaVinci Resolve, code editors, etc.).
- **Maker:** Farza (Farza Majeed). Company in **YC Spring 2026**.
- **Website:** heyclicky.com (also clicky.so).
- **Launches:** Product Hunt 2026-04-11 (#6 of the day, 135 upvotes); later "Clicky 2.0".
- **Pricing (product):** free tier; **Clicky Pro $20/mo** (~150 agent messages + unlimited voice). Windows waitlisted as of mid-2026.
- **Open source:** original codebase is **MIT** at `github.com/farzaa/clicky`. Newer features (2.0 / agent mode) are kept **private**. Community forks exist (e.g. `R44VC0RP/clicky`, `iFurySt/clicky`).

## 2. Product features
| Feature | Details |
|---|---|
| Talk mode | Hold **Ctrl + Option** (push-to-talk), ask about what's on screen, get spoken answer + on-screen pointing |
| Pointing | Blue cursor flies (bezier arc) to the referenced element; works across multiple monitors |
| Response bubble | Text bubble + live waveform next to cursor |
| Model picker | Claude Sonnet / Opus selectable in menu-bar panel |
| Transient cursor | If "Show Clicky" is off, the overlay fades in only for an interaction, then auto-hides 1 s after idle |
| Agent mode (2.0, closed) | Background agents that research/build/automate; integrations: Gmail, Google Calendar, Notion, Linear, Apple Notes/Calendar/Reminders. No Outlook/M365. Runs only while the Mac app is open |

Compared to **Cluely**: Clicky = software-usability tutor (voice, pointing); Cluely = hidden prompter for live calls.

## 3. Architecture (open-source version)

```
 ┌────────────── macOS menu-bar app (Swift/SwiftUI + AppKit) ──────────────┐
 │ Ctrl+Option held ─► CGEvent tap (GlobalPushToTalkShortcutMonitor)       │
 │   └► AVAudioEngine mic ─► PCM16 ─► AssemblyAI v3 WebSocket (live STT)   │
 │ key released ─► final transcript                                         │
 │   + ScreenCaptureKit screenshot(s) of every display (labeled screenN)    │
 │   ─► POST /chat (Claude vision, SSE stream)                              │
 │   ◄─ streamed text with [POINT:x,y:label:screenN] tags                  │
 │   ├► POST /tts (ElevenLabs) ─► AVAudioPlayer speaks reply               │
 │   └► OverlayWindow animates blue cursor to x,y on screenN               │
 └──────────────────────────────┬───────────────────────────────────────────┘
                                │ (app never holds API keys)
                ┌───────────────▼────────────────┐
                │ Cloudflare Worker proxy (TS)    │
                │ /chat  → api.anthropic.com      │
                │ /tts   → api.elevenlabs.io      │
                │ /transcribe-token → AssemblyAI  │
                └─────────────────────────────────┘
```

### Pipeline step by step
1. **Hotkey**: listen-only `CGEvent` tap catches Ctrl+Option even when app is backgrounded (AppKit global monitors are unreliable for modifier-only shortcuts).
2. **Voice capture**: `AVAudioEngine` → converted to PCM16 mono (`BuddyAudioConversionSupport`).
3. **Transcription**: provider abstraction (`BuddyTranscriptionProvider`), chosen via Info.plist:
   - **AssemblyAI** (default): app fetches a temp token from Worker `/transcribe-token` (480 s expiry), opens v3 streaming WebSocket.
   - **OpenAI**: buffers audio, uploads WAV on key release.
   - **Apple Speech**: local fallback.
4. **Screenshot**: `CompanionScreenCaptureUtility` uses ScreenCaptureKit, returns labeled image per monitor.
5. **LLM**: `ClaudeAPI` sends transcript + images + conversation history to Worker `/chat`; streams SSE back. Includes TLS warm-up and MIME detection. (`OpenAIAPI` exists as alternative vision client.)
6. **Pointing**: Claude embeds `[POINT:x,y:label:screenN]` tags; app parses them and maps screenshot coords → display coords. `ElementLocationDetector` helps locate elements.
7. **Speech**: `ElevenLabsTTSClient` posts text to `/tts`, plays mp3 with `AVAudioPlayer`; `isPlaying` drives transient-cursor timing.
8. **UI**: overlay is a full-screen transparent, non-activating `NSPanel` that joins all Spaces, rendering SwiftUI via `NSHostingView`.

## 4. Source files (`leanring-buddy/` — the misspelling is intentional; do not rename)
| File | ~Lines | Role |
|---|---|---|
| `leanring_buddyApp.swift` | 89 | Entry; `@NSApplicationDelegateAdaptor` → `CompanionAppDelegate`; no main window |
| `CompanionManager.swift` | 1026 | Central state machine for the whole pipeline; holds Worker URL |
| `MenuBarPanelManager.swift` | 243 | `NSStatusItem` + borderless floating `NSPanel`, outside-click dismiss |
| `CompanionPanelView.swift` | 761 | Panel UI: status, instructions, model picker, permissions, feedback, quit |
| `OverlayWindow.swift` | 881 | Blue cursor, bubble, waveform, bezier pointing, multi-monitor mapping |
| `CompanionResponseOverlay.swift` | 217 | Response bubble + waveform view |
| `CompanionScreenCaptureUtility.swift` | 132 | ScreenCaptureKit multi-monitor capture |
| `BuddyDictationManager.swift` | 866 | Push-to-talk voice pipeline, permissions, key-terms, audio levels |
| `BuddyTranscriptionProvider.swift` | 100 | STT protocol + factory |
| `AssemblyAIStreamingTranscriptionProvider.swift` | 478 | Streaming STT; holds Worker URL; one shared `URLSession` |
| `OpenAIAudioTranscriptionProvider.swift` | 317 | Upload-based STT |
| `AppleSpeechTranscriptionProvider.swift` | 147 | Local STT fallback |
| `BuddyAudioConversionSupport.swift` | 108 | PCM16 / WAV conversion |
| `GlobalPushToTalkShortcutMonitor.swift` | 132 | CGEvent tap hotkey monitor |
| `ClaudeAPI.swift` | 291 | Claude vision client, SSE + non-streaming |
| `OpenAIAPI.swift` | 142 | GPT vision client |
| `ElevenLabsTTSClient.swift` | 81 | TTS playback |
| `ElementLocationDetector.swift` | 335 | Finds UI element locations for pointing |
| `DesignSystem.swift` | 880 | Tokens: `DS.Colors`, `DS.CornerRadius`, … |
| `ClickyAnalytics.swift` | 121 | PostHog analytics |
| `WindowPositionManager.swift` | 262 | Window placement, Screen Recording permission flow |
| `AppBundleConfiguration.swift` | 28 | Reads Info.plist config |
| `worker/src/index.ts` | 142 | Cloudflare Worker proxy |

## 5. Cloudflare Worker (`worker/src/index.ts`)
| Route (POST) | Upstream | Notes |
|---|---|---|
| `/chat` | `https://api.anthropic.com/v1/messages` | headers `x-api-key`, `anthropic-version: 2023-06-01`; body passed through; streams `text/event-stream` |
| `/tts` | `https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}` | `xi-api-key`, `accept: audio/mpeg`; returns mp3 |
| `/transcribe-token` | `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=480` | `authorization` = AssemblyAI key; returns JSON token |
Non-POST → 405; unknown route → 404; upstream errors returned with status/body.

**Env:** secrets `ANTHROPIC_API_KEY`, `ASSEMBLYAI_API_KEY`, `ELEVENLABS_API_KEY`; `ELEVENLABS_VOICE_ID` in `wrangler.toml` (non-secret).

## 6. Setup / build
```bash
# Worker
cd worker && npm install
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ASSEMBLYAI_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler deploy
# Local dev: worker/.dev.vars with keys, then `npx wrangler dev` → http://localhost:8787
```
- Put the Worker URL in `CompanionManager.swift` and `AssemblyAIStreamingTranscriptionProvider.swift`.
- `open leanring-buddy.xcodeproj` → scheme `leanring-buddy` → set signing team → Cmd+R.
- **Requirements:** macOS 14.2+, Xcode 15+. Apple Silicon + Intel.
- **Permissions:** Microphone, Accessibility (hotkey), Screen Recording, Screen Content (ScreenCaptureKit).
- **Never run `xcodebuild` from terminal** — it invalidates TCC permissions (must re-grant screen/mic/accessibility).

## 7. Key engineering decisions / gotchas
- App never calls third-party APIs directly; Worker hides keys.
- Single long-lived `URLSession` for AssemblyAI — per-session create/invalidate corrupts the connection pool → socket errors on rapid reconnects.
- CGEvent tap (listen-only) instead of `NSEvent` global monitor for modifier-only hotkeys.
- Panels are **non-activating** so they never steal focus from the app the user is learning.
- Menu-bar only (no Dock icon, no main window).

## 8. Coding conventions (from AGENTS.md)
- Clarity over brevity; long descriptive names (e.g. `originalQuestionLastAnsweredDate`); don't abbreviate params when passing.
- SwiftUI everywhere except where AppKit is required (`NSPanel`).
- All state updates on `@MainActor`; async/await everywhere; MVVM with `@StateObject`.
- Comments explain *why* (esp. AppKit bridging). Every interactive element gets a pointer cursor on hover.
- Don't: add out-of-scope features, add docstrings to untouched code, fix known non-blocking Swift 6 warnings, rename the project, run `xcodebuild`.
- Update AGENTS.md when adding/removing files, new patterns, build changes, or >50-line size changes.

## 9. Recreating it (clone checklist)
1. Menu-bar SwiftUI app with `NSStatusItem` + floating `NSPanel`.
2. Global push-to-talk via CGEvent tap.
3. Mic → streaming STT (AssemblyAI token via proxy).
4. ScreenCaptureKit multi-monitor screenshots.
5. Claude vision call with system prompt instructing `[POINT:x,y:label:screenN]` output; stream & parse.
6. TTS (ElevenLabs) playback in parallel with streaming text.
7. Transparent full-screen overlay with animated cursor + bubble.
8. Cloudflare Worker proxy holding all keys.

## Sources
- https://github.com/farzaa/clicky (README, AGENTS.md, worker/src/index.ts)
- https://hunted.space/product/clicky-2 · https://hunted.space/product/clicky-2-0
- https://www.usecarly.com/blog/cluely-vs-clicky/
- https://creatorstoolbox.beehiiv.com/p/a-free-ai-buddy-for-any-mac-app
- https://letsdatascience.com/news/tiny-ai-cursor-companion-enhances-desktop-interaction-and-pr-39c7ddc8
