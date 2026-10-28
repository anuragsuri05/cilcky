# Amazze

An AI buddy that lives next to your cursor on macOS. It sees your screen, listens when you talk, answers out loud, and flies a blue cursor to point at exactly what you need to click.

Hold **Control + Option**, ask a question about whatever's on screen, let go — Amazze answers by voice and points at the answer.

> Amazze is a fork of the open-source [Clicky](https://github.com/farzaa/clicky) by Farza (MIT license). See [LICENSE](LICENSE).

## How it works

Amazze works with **any one** of these API keys — Claude, OpenAI (ChatGPT), Gemini, OpenRouter or Groq.

```
Ctrl+Option held ─► mic audio is recorded
key released     ─► speech-to-text (Groq Whisper / OpenAI, else on-device)
                 ─► screenshot of every display (ScreenCaptureKit)
                 ─► the "brain" (your provider, streamed) ─► reply text + [POINT:x,y:label:screenN]
                       ├─► voice (Groq Orpheus / OpenAI, else macOS system voice)
                       └─► blue cursor flies to the pointed element
```

The app never holds a key. It talks to a small Cloudflare Worker (`worker/`) that holds the keys and forwards requests:

| Route | Goes to |
|---|---|
| `POST /chat` | the brain — Claude natively; OpenAI, Gemini, OpenRouter, Groq via translated chat completions |
| `POST /tts` | voice — Groq Orpheus or OpenAI TTS |
| `POST /transcribe` | speech-to-text — Groq Whisper or OpenAI |

### Which key gives what

| Key (Worker secret) | Brain (default model) | Voice + speech-to-text |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude Opus 5.5 — same brain as Clicky; panel picker switches to Sonnet 5.5 | — |
| `OPENAI_API_KEY` | `gpt-6.1-sol` | ✅ `gpt-transcribe`, `gpt-4o-mini-tts` |
| `GEMINI_API_KEY` | `gemini-3.8-flash` | — |
| `OPENROUTER_API_KEY` | `anthropic/claude-opus-5.5` (any OpenRouter model) | — |
| `GROQ_API_KEY` | `qwen/qwen3.8-27b` (free tier ≈ 2 questions/min) | ✅ Whisper, Orpheus |

With several keys, `CHAT_PROVIDER = "auto"` picks the brain in the order above (smartest first) and `SPEECH_PROVIDER = "auto"` picks Groq, then OpenAI, for voice and speech-to-text. With no Groq or OpenAI key, Amazze transcribes on-device and speaks with the macOS voice. Best combo for Clicky-level smarts with nice voice: **Claude + Groq**.

## Setup

### Prerequisites

- macOS 14.2+ and **Xcode 15+** — or no Xcode at all: `./scripts/build-without-xcode.sh` builds a test copy with the Command Line Tools
- Node.js 18+
- A free [Cloudflare](https://cloudflare.com) account
- At least one API key from the table above
- Groq voice only: accept the Orpheus terms once at https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english

### 1. Deploy the Worker

```bash
cd worker
npm install
npx wrangler secret put ANTHROPIC_API_KEY   # and/or OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY
npx wrangler deploy
```

Choose providers and models in `worker/wrangler.toml`: `CHAT_PROVIDER` (`auto`, `anthropic`, `openai`, `gemini`, `openrouter`, `groq`), `CHAT_MODEL` (empty = default above, or any model ID that provider accepts — e.g. `google/gemini-3.8-flash` on OpenRouter), `SPEECH_PROVIDER` (`auto`, `groq`, `openai`) and `VOICE` (Groq: autumn, diana, hannah, austin, daniel, troy · OpenAI: marin, cedar, alloy, …). Deploy prints a URL like `https://amazze-proxy.<you>.workers.dev`.

For local development instead: put `KEY=value` lines in `worker/.dev.vars` (git-ignored), then `npm run dev` → `http://localhost:8787`.

### 2. Point the app at your Worker

Set `AmazzeWorkerBaseURL` in `Amazze/Info.plist`. It defaults to `http://localhost:8787` (local `wrangler dev`); change it to your deployed `workers.dev` URL before shipping.

### 3. Optional settings (`Amazze/Info.plist`)

Everything here is off when left empty.

| Key | What it does |
|---|---|
| `PostHogAPIKey`, `PostHogHost` | Usage analytics via PostHog |
| `EmailSubmissionURL` | Where the onboarding email form posts (e.g. a FormSpark URL) |
| `OnboardingVideoURL` | Intro video (HLS/MP4). Without it, onboarding goes straight to the pointing demo |
| `FeedbackURL` | Link opened by the "Got feedback?" button |
| `SUFeedURL`, `SUPublicEDKey` | Sparkle auto-update feed + signing key (updater is off by default) |
| `VoiceTranscriptionProvider` | `worker` (default — Groq/OpenAI via the Worker, on-device fallback), `assemblyai`, `openai`, or `apple` |

### 4. Build and run

```bash
open Amazze.xcodeproj
```

1. Choose the **Amazze** scheme.
2. Signing & Capabilities → pick your own Team (the bundle ID is `com.amazze.app`; change it if needed).
3. **Cmd + R**.

Amazze appears in the menu bar (no Dock icon). Open it, grant the permissions, hit Start.

> Build from Xcode, not `xcodebuild` in the terminal — a terminal build re-signs the app and macOS drops its granted permissions.

### Permissions

- **Microphone** — push-to-talk
- **Accessibility** — the global Control + Option shortcut
- **Screen Recording** / **Screen Content** — screenshots, only taken when you press the hotkey

## Project structure

```
Amazze/                       Swift app
  AmazzeApp.swift               entry point (menu-bar only)
  CompanionManager.swift        central state machine + system prompts
  CompanionPanelView.swift      menu-bar panel UI
  OverlayWindow.swift           blue cursor, bubble, pointing animation
  ClaudeAPI.swift               chat client (Anthropic format; Worker translates for non-Claude providers)
  ElevenLabsTTSClient.swift     voice playback (served by Groq/OpenAI via Worker)
  OpenAIAudioTranscriptionProvider.swift  speech-to-text via Worker, on-device fallback
  BuddyDictation*.swift         push-to-talk pipeline
  AmazzeAnalytics.swift         optional PostHog analytics
worker/                       Cloudflare Worker proxy
AGENTS.md (= CLAUDE.md)       full architecture + coding rules for AI agents
```

## Customize

- Personality / behaviour: the system prompts in `CompanionManager.swift` (search for `you're amazze`).
- Look: `DesignSystem.swift` (colors, radii) and `OverlayWindow.swift` (cursor).
- App icon: `Amazze/Assets.xcassets/AppIcon.appiconset` — still the original icon; replace with your own.
- Onboarding music: `Amazze/ff.mp3` (inherited from upstream) — replace with audio you have rights to before shipping.
