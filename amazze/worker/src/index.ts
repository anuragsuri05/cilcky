/**
 * Amazze Proxy Worker
 *
 * Proxies every AI call the app makes so the app never ships with a raw API
 * key. Works with whichever provider keys are set as Cloudflare secrets:
 *   ANTHROPIC_API_KEY · OPENAI_API_KEY · GEMINI_API_KEY · OPENROUTER_API_KEY · GROQ_API_KEY
 *
 * Routes:
 *   POST /chat        → the "brain". The app always speaks the Anthropic Messages
 *                       format: Claude gets it as-is (like the original Clicky);
 *                       OpenAI, Gemini, OpenRouter and Groq get it translated to
 *                       OpenAI chat completions, with the SSE stream translated back.
 *   POST /tts         → voice. Groq Orpheus (chunked to 200 chars, WAVs stitched)
 *                       or OpenAI TTS. 501 when neither key exists — the app then
 *                       speaks with the macOS system voice.
 *   POST /transcribe  → speech-to-text. Groq Whisper or OpenAI. 501 when neither
 *                       key exists — the app then transcribes on-device.
 *
 * Provider choice: CHAT_PROVIDER / SPEECH_PROVIDER vars ("auto" = first provider
 * with a key, smartest first for chat), CHAT_MODEL to override the model.
 */

interface Env {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  GROQ_API_KEY?: string;
  CHAT_PROVIDER?: string;
  CHAT_MODEL?: string;
  SPEECH_PROVIDER?: string;
  VOICE?: string;
}

type ChatProviderName = "anthropic" | "openai" | "gemini" | "openrouter" | "groq";
type SpeechProviderName = "groq" | "openai";

interface OpenAICompatibleChatProvider {
  displayName: string;
  chatCompletionsURL: string;
  apiKeyEnvName: keyof Env;
  defaultModel: string;
  // OpenAI-style APIs disagree on the name of the output-length field
  maxOutputTokensFieldName: "max_tokens" | "max_completion_tokens";
  // Reasoning models spend output tokens on thinking first, so give them room
  minimumOutputTokens: number;
  maxImagesPerRequest: number;
  extraRequestFields: Record<string, unknown>;
  extraRequestHeaders: Record<string, string>;
}

// Auto mode picks the first provider with a key, most capable first.
const CHAT_PROVIDER_PRIORITY: ChatProviderName[] = ["anthropic", "openai", "gemini", "openrouter", "groq"];
const SPEECH_PROVIDER_PRIORITY: SpeechProviderName[] = ["groq", "openai"];

const CHAT_PROVIDER_API_KEY_ENV_NAMES: Record<ChatProviderName, keyof Env> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
};

// Claude: Opus 5.5 is the default; the app's Sonnet/Opus picker can choose
// claude-sonnet-5-5. Low effort keeps spoken answers fast.
const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
const ANTHROPIC_MINIMUM_OUTPUT_TOKENS = 4096;
// Models that accept server-side refusal fallbacks ("default" routing)
const ANTHROPIC_MODELS_WITH_SERVER_SIDE_FALLBACK = ["claude-opus-5-5", "claude-sonnet-5-5"];

const OPENAI_COMPATIBLE_CHAT_PROVIDERS: Record<Exclude<ChatProviderName, "anthropic">, OpenAICompatibleChatProvider> = {
  openai: {
    displayName: "OpenAI",
    chatCompletionsURL: "https://api.openai.com/v1/chat/completions",
    apiKeyEnvName: "OPENAI_API_KEY",
    defaultModel: "gpt-6.1-sol",
    maxOutputTokensFieldName: "max_completion_tokens",
    minimumOutputTokens: 4096,
    maxImagesPerRequest: 10,
    extraRequestFields: { reasoning_effort: "low" },
    extraRequestHeaders: {},
  },
  gemini: {
    displayName: "Gemini",
    chatCompletionsURL: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    apiKeyEnvName: "GEMINI_API_KEY",
    defaultModel: "gemini-3.8-flash",
    maxOutputTokensFieldName: "max_completion_tokens",
    minimumOutputTokens: 4096,
    maxImagesPerRequest: 10,
    extraRequestFields: { reasoning_effort: "low" },
    extraRequestHeaders: {},
  },
  openrouter: {
    displayName: "OpenRouter",
    chatCompletionsURL: "https://openrouter.ai/api/v1/chat/completions",
    apiKeyEnvName: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-opus-5.5",
    maxOutputTokensFieldName: "max_tokens",
    minimumOutputTokens: 4096,
    maxImagesPerRequest: 10,
    extraRequestFields: { reasoning: { effort: "low" } },
    extraRequestHeaders: { "X-Title": "Amazze" },
  },
  groq: {
    displayName: "Groq",
    chatCompletionsURL: "https://api.groq.com/openai/v1/chat/completions",
    apiKeyEnvName: "GROQ_API_KEY",
    defaultModel: "qwen/qwen3.8-27b",
    maxOutputTokensFieldName: "max_completion_tokens",
    minimumOutputTokens: 0,
    // Groq vision models accept at most 3 images per request
    maxImagesPerRequest: 3,
    extraRequestFields: {},
    extraRequestHeaders: {},
  },
};

const SPEECH_PROVIDERS: Record<SpeechProviderName, {
  apiKeyEnvName: keyof Env;
  transcriptionURL: string;
  transcriptionModel: string;
  speechURL: string;
  speechModel: string;
  defaultVoice: string;
  // Orpheus rejects long inputs, so its text is split and the WAVs stitched
  maxCharactersPerSpeechRequest: number;
}> = {
  groq: {
    apiKeyEnvName: "GROQ_API_KEY",
    transcriptionURL: "https://api.groq.com/openai/v1/audio/transcriptions",
    transcriptionModel: "whisper-large-v3-turbo",
    speechURL: "https://api.groq.com/openai/v1/audio/speech",
    speechModel: "canopylabs/orpheus-v1-english",
    defaultVoice: "austin",
    maxCharactersPerSpeechRequest: 200,
  },
  openai: {
    apiKeyEnvName: "OPENAI_API_KEY",
    transcriptionURL: "https://api.openai.com/v1/audio/transcriptions",
    transcriptionModel: "gpt-transcribe",
    speechURL: "https://api.openai.com/v1/audio/speech",
    speechModel: "gpt-4o-mini-tts",
    defaultVoice: "marin",
    maxCharactersPerSpeechRequest: 4000,
  },
};

// Free tiers (Groq especially) allow only a few screenshot-sized requests per
// minute and answer 429 with "try again in Ns". Up to this much total waiting is
// absorbed here (the user just hears the answer a bit later); beyond it the 429
// is passed through.
const MAX_TOTAL_RATE_LIMIT_WAIT_SECONDS = 25;
const MAX_RATE_LIMIT_RETRIES = 3;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      if (url.pathname === "/chat") {
        return await handleChat(request, env);
      }

      if (url.pathname === "/tts") {
        return await handleTTS(request, env);
      }

      if (url.pathname === "/transcribe") {
        return await handleTranscribe(request, env);
      }
    } catch (error) {
      console.error(`[${url.pathname}] Unhandled error:`, error);
      return jsonResponse({ error: String(error) }, 500);
    }

    return new Response("Not found", { status: 404 });
  },
};

// MARK: - Provider selection

function hasAPIKey(env: Env, apiKeyEnvName: keyof Env): boolean {
  return Boolean(env[apiKeyEnvName]?.trim());
}

function resolveChatProvider(env: Env): ChatProviderName | null {
  const requestedProvider = (env.CHAT_PROVIDER ?? "auto").trim().toLowerCase();
  if (requestedProvider !== "auto" && requestedProvider !== "") {
    return requestedProvider in CHAT_PROVIDER_API_KEY_ENV_NAMES ? (requestedProvider as ChatProviderName) : null;
  }
  return CHAT_PROVIDER_PRIORITY.find((providerName) => hasAPIKey(env, CHAT_PROVIDER_API_KEY_ENV_NAMES[providerName])) ?? null;
}

function resolveSpeechProvider(env: Env): SpeechProviderName | null {
  const requestedProvider = (env.SPEECH_PROVIDER ?? "auto").trim().toLowerCase();
  if (requestedProvider !== "auto" && requestedProvider !== "") {
    return requestedProvider in SPEECH_PROVIDERS && hasAPIKey(env, SPEECH_PROVIDERS[requestedProvider as SpeechProviderName].apiKeyEnvName)
      ? (requestedProvider as SpeechProviderName)
      : null;
  }
  return SPEECH_PROVIDER_PRIORITY.find((providerName) => hasAPIKey(env, SPEECH_PROVIDERS[providerName].apiKeyEnvName)) ?? null;
}

// MARK: - /chat

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicMessagesRequest {
  model?: string;
  max_tokens?: number;
  stream?: boolean;
  system?: string;
  messages: AnthropicMessage[];
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const anthropicRequest = (await request.json()) as AnthropicMessagesRequest;
  const chatProviderName = resolveChatProvider(env);

  if (!chatProviderName) {
    return jsonResponse({ error: `No chat provider available. Set one of ${Object.values(CHAT_PROVIDER_API_KEY_ENV_NAMES).join(", ")} (CHAT_PROVIDER="${env.CHAT_PROVIDER}").` }, 401);
  }
  if (!hasAPIKey(env, CHAT_PROVIDER_API_KEY_ENV_NAMES[chatProviderName])) {
    return jsonResponse({ error: `CHAT_PROVIDER is "${chatProviderName}" but ${CHAT_PROVIDER_API_KEY_ENV_NAMES[chatProviderName]} is not set.` }, 401);
  }

  if (chatProviderName === "anthropic") {
    return handleChatWithClaude(anthropicRequest, env);
  }
  return handleChatWithOpenAICompatibleProvider(anthropicRequest, OPENAI_COMPATIBLE_CHAT_PROVIDERS[chatProviderName], env);
}

/** Claude speaks the app's format natively, so the request and stream pass through. */
async function handleChatWithClaude(anthropicRequest: AnthropicMessagesRequest, env: Env): Promise<Response> {
  // CHAT_MODEL wins; otherwise honor the app's Sonnet/Opus picker when it
  // names a Claude model, else the default.
  const requestedModel = anthropicRequest.model?.startsWith("claude-") ? anthropicRequest.model : undefined;
  const claudeModel = env.CHAT_MODEL?.trim() || requestedModel || ANTHROPIC_DEFAULT_MODEL;

  const claudeRequestBody: Record<string, unknown> = {
    ...anthropicRequest,
    model: claudeModel,
    // Thinking tokens count toward max_tokens, so the app's small limits
    // (1024 / 256) could cut answers off — give the model room.
    max_tokens: Math.max(anthropicRequest.max_tokens ?? 1024, ANTHROPIC_MINIMUM_OUTPUT_TOKENS),
    output_config: { effort: "low" },
  };
  const claudeRequestHeaders: Record<string, string> = {
    "x-api-key": env.ANTHROPIC_API_KEY!,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (ANTHROPIC_MODELS_WITH_SERVER_SIDE_FALLBACK.includes(claudeModel)) {
    // If a safety classifier declines, Anthropic retries on a fallback model
    claudeRequestBody.fallbacks = "default";
    claudeRequestHeaders["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }

  const claudeResponse = await fetchWithRateLimitRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: claudeRequestHeaders,
    body: JSON.stringify(claudeRequestBody),
  });

  if (!claudeResponse.ok) {
    const errorBody = await claudeResponse.text();
    console.error(`[/chat] Claude API error ${claudeResponse.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: claudeResponse.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(claudeResponse.body, {
    status: claudeResponse.status,
    headers: {
      "content-type": claudeResponse.headers.get("content-type") || "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

async function handleChatWithOpenAICompatibleProvider(
  anthropicRequest: AnthropicMessagesRequest,
  chatProvider: OpenAICompatibleChatProvider,
  env: Env
): Promise<Response> {
  const isStreamingRequest = anthropicRequest.stream === true;
  const chatModel = env.CHAT_MODEL?.trim() || chatProvider.defaultModel;

  const providerRequestBody: Record<string, unknown> = {
    model: chatModel,
    stream: isStreamingRequest,
    messages: convertAnthropicMessagesToOpenAIMessages(anthropicRequest, chatProvider.maxImagesPerRequest),
    ...chatProvider.extraRequestFields,
  };
  providerRequestBody[chatProvider.maxOutputTokensFieldName] = Math.max(
    anthropicRequest.max_tokens ?? 1024,
    chatProvider.minimumOutputTokens
  );

  const providerResponse = await fetchWithRateLimitRetry(chatProvider.chatCompletionsURL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env[chatProvider.apiKeyEnvName]}`,
      "content-type": "application/json",
      ...chatProvider.extraRequestHeaders,
    },
    body: JSON.stringify(providerRequestBody),
  });

  if (!providerResponse.ok) {
    const errorBody = await providerResponse.text();
    console.error(`[/chat] ${chatProvider.displayName} API error ${providerResponse.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: providerResponse.status,
      headers: { "content-type": "application/json" },
    });
  }

  if (!isStreamingRequest) {
    const providerCompletion = (await providerResponse.json()) as {
      choices: { message: { content: string | null } }[];
    };
    const responseText = stripThinkingBlocks(providerCompletion.choices[0]?.message?.content ?? "");
    return jsonResponse({
      type: "message",
      role: "assistant",
      model: chatModel,
      content: [{ type: "text", text: responseText }],
      stop_reason: "end_turn",
    });
  }

  return new Response(convertOpenAIStreamToAnthropicStream(providerResponse.body!, chatModel), {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

function convertAnthropicMessagesToOpenAIMessages(
  anthropicRequest: AnthropicMessagesRequest,
  maxImagesPerRequest: number
): unknown[] {
  const openAIMessages: unknown[] = [];

  if (anthropicRequest.system) {
    openAIMessages.push({ role: "system", content: anthropicRequest.system });
  }

  // Some providers cap images per request, so keep the first few screens
  // and drop the rest rather than failing the whole request.
  let remainingImageAllowance = maxImagesPerRequest;

  for (const anthropicMessage of anthropicRequest.messages) {
    if (typeof anthropicMessage.content === "string") {
      openAIMessages.push({ role: anthropicMessage.role, content: anthropicMessage.content });
      continue;
    }

    const openAIContentParts: unknown[] = [];
    for (const contentBlock of anthropicMessage.content) {
      if (contentBlock.type === "text") {
        openAIContentParts.push({ type: "text", text: contentBlock.text });
      } else if (contentBlock.type === "image" && remainingImageAllowance > 0) {
        remainingImageAllowance -= 1;
        openAIContentParts.push({
          type: "image_url",
          image_url: { url: `data:${contentBlock.source.media_type};base64,${contentBlock.source.data}` },
        });
      }
    }
    openAIMessages.push({ role: anthropicMessage.role, content: openAIContentParts });
  }

  return openAIMessages;
}

/**
 * Re-emits an OpenAI-style SSE stream (`choices[0].delta.content`) as the
 * Anthropic-style SSE events the app's ClaudeAPI parser understands
 * (`content_block_delta` with a `text_delta`).
 */
function convertOpenAIStreamToAnthropicStream(
  groqStream: ReadableStream<Uint8Array>,
  modelName: string
): ReadableStream<Uint8Array> {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const thinkingBlockFilter = new StreamingThinkingBlockFilter();

  const encodeAnthropicEvent = (eventName: string, eventPayload: unknown) =>
    textEncoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(eventPayload)}\n\n`);

  const encodeTextDelta = (text: string) =>
    encodeAnthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encodeAnthropicEvent("message_start", {
          type: "message_start",
          message: { role: "assistant", model: modelName, content: [] },
        })
      );
      controller.enqueue(
        encodeAnthropicEvent("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })
      );

      const groqStreamReader = groqStream.getReader();
      let unprocessedText = "";

      try {
        while (true) {
          const { done, value } = await groqStreamReader.read();
          if (done) break;

          unprocessedText += textDecoder.decode(value, { stream: true });
          const completeLines = unprocessedText.split("\n");
          unprocessedText = completeLines.pop() ?? "";

          for (const line of completeLines) {
            const trimmedLine = line.trim();
            if (!trimmedLine.startsWith("data:")) continue;

            const eventData = trimmedLine.slice("data:".length).trim();
            if (eventData === "[DONE]") continue;

            let groqChunk: { choices?: { delta?: { content?: string | null } }[]; error?: unknown };
            try {
              groqChunk = JSON.parse(eventData);
            } catch {
              continue;
            }

            if (groqChunk.error) {
              controller.enqueue(encodeAnthropicEvent("error", { type: "error", error: groqChunk.error }));
              continue;
            }

            const textChunk = groqChunk.choices?.[0]?.delta?.content;
            if (!textChunk) continue;

            const visibleText = thinkingBlockFilter.push(textChunk);
            if (visibleText) controller.enqueue(encodeTextDelta(visibleText));
          }
        }
      } catch (error) {
        console.error("[/chat] Stream translation error:", error);
        controller.enqueue(encodeAnthropicEvent("error", { type: "error", error: { message: String(error) } }));
      }

      controller.enqueue(encodeAnthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
      controller.enqueue(
        encodeAnthropicEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } })
      );
      controller.enqueue(encodeAnthropicEvent("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });
}

/**
 * Some models (e.g. Qwen) can emit `<think>…</think>` reasoning before
 * the answer. That must never be spoken aloud, so it is dropped from the
 * stream. Text is held back only while it could still be the start of a tag.
 */
class StreamingThinkingBlockFilter {
  private pendingText = "";
  private isInsideThinkingBlock = false;

  push(textChunk: string): string {
    this.pendingText += textChunk;
    let visibleText = "";

    while (this.pendingText.length > 0) {
      if (this.isInsideThinkingBlock) {
        const closingTagIndex = this.pendingText.indexOf("</think>");
        if (closingTagIndex === -1) {
          // Keep only a tail that might be a partial closing tag
          this.pendingText = this.pendingText.slice(-"</think>".length);
          break;
        }
        this.pendingText = this.pendingText.slice(closingTagIndex + "</think>".length).replace(/^\s+/, "");
        this.isInsideThinkingBlock = false;
        continue;
      }

      const openingTagIndex = this.pendingText.indexOf("<think>");
      if (openingTagIndex !== -1) {
        visibleText += this.pendingText.slice(0, openingTagIndex);
        this.pendingText = this.pendingText.slice(openingTagIndex + "<think>".length);
        this.isInsideThinkingBlock = true;
        continue;
      }

      const partialTagStartIndex = indexOfPossiblePartialTag(this.pendingText, "<think>");
      visibleText += this.pendingText.slice(0, partialTagStartIndex);
      this.pendingText = this.pendingText.slice(partialTagStartIndex);
      break;
    }

    return visibleText;
  }
}

/** Index where a trailing prefix of `tag` begins in `text`, or text.length if none. */
function indexOfPossiblePartialTag(text: string, tag: string): number {
  for (let prefixLength = Math.min(tag.length - 1, text.length); prefixLength > 0; prefixLength--) {
    if (text.endsWith(tag.slice(0, prefixLength))) {
      return text.length - prefixLength;
    }
  }
  return text.length;
}

function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

// MARK: - /tts

async function handleTTS(request: Request, env: Env): Promise<Response> {
  const ttsRequest = (await request.json()) as { text?: string };
  const textToSpeak = (ttsRequest.text ?? "").trim();
  if (!textToSpeak) {
    return jsonResponse({ error: "Missing text" }, 400);
  }

  const speechProviderName = resolveSpeechProvider(env);
  if (!speechProviderName) {
    // The app treats any TTS failure as "use the macOS system voice"
    return jsonResponse({ error: "No voice provider: set GROQ_API_KEY or OPENAI_API_KEY." }, 501);
  }
  const speechProvider = SPEECH_PROVIDERS[speechProviderName];

  const textChunks = splitTextIntoSpeakableChunks(textToSpeak, speechProvider.maxCharactersPerSpeechRequest);

  // Synthesize all chunks in parallel to keep latency close to a single call
  const chunkResponses = await Promise.all(
    textChunks.map((textChunk) =>
      fetchWithRateLimitRetry(speechProvider.speechURL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env[speechProvider.apiKeyEnvName]}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: speechProvider.speechModel,
          voice: env.VOICE?.trim() || speechProvider.defaultVoice,
          input: textChunk,
          response_format: "wav",
        }),
      })
    )
  );

  const failedChunkResponse = chunkResponses.find((chunkResponse) => !chunkResponse.ok);
  if (failedChunkResponse) {
    const errorBody = await failedChunkResponse.text();
    console.error(`[/tts] ${speechProviderName} TTS error ${failedChunkResponse.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: failedChunkResponse.status,
      headers: { "content-type": "application/json" },
    });
  }

  const chunkWavFiles = await Promise.all(
    chunkResponses.map(async (chunkResponse) => new Uint8Array(await chunkResponse.arrayBuffer()))
  );

  return new Response(concatenateWavFiles(chunkWavFiles), {
    status: 200,
    headers: { "content-type": "audio/wav" },
  });
}

/**
 * Splits text at sentence boundaries (falling back to word boundaries)
 * so each chunk fits the TTS character limit and still sounds natural.
 */
function splitTextIntoSpeakableChunks(text: string, maxCharactersPerChunk: number): string[] {
  // Only split where punctuation is followed by whitespace, so things like
  // "h.264", "v2.0" or "file.swift" stay intact.
  const sentences = text.split(/(?<=[.!?]["')\]]*)\s+/).filter((sentence) => sentence.length > 0);
  const speakableChunks: string[] = [];
  let currentChunk = "";

  const flushCurrentChunk = () => {
    if (currentChunk.trim()) speakableChunks.push(currentChunk.trim());
    currentChunk = "";
  };

  for (const sentence of sentences) {
    const chunkWithSentence = currentChunk ? `${currentChunk} ${sentence}` : sentence;
    if (chunkWithSentence.length <= maxCharactersPerChunk) {
      currentChunk = chunkWithSentence;
      continue;
    }

    flushCurrentChunk();

    if (sentence.length <= maxCharactersPerChunk) {
      currentChunk = sentence;
      continue;
    }

    // A single sentence longer than the limit: break it on word boundaries
    for (const word of sentence.split(/\s+/)) {
      if (!word) continue;
      if ((currentChunk + " " + word).trim().length > maxCharactersPerChunk) {
        flushCurrentChunk();
      }
      currentChunk = currentChunk ? `${currentChunk} ${word}` : word.slice(0, maxCharactersPerChunk);
    }
  }

  flushCurrentChunk();
  return speakableChunks;
}

/**
 * Joins WAV files that share one audio format into a single WAV by keeping
 * the first file's `fmt ` chunk and concatenating every file's sample data.
 */
function concatenateWavFiles(wavFiles: Uint8Array[]): Uint8Array {
  if (wavFiles.length === 1) return wavFiles[0];

  let formatChunk: Uint8Array | null = null;
  const sampleDataParts: Uint8Array[] = [];

  for (const wavFile of wavFiles) {
    const parsedWav = parseWavChunks(wavFile);
    formatChunk ??= parsedWav.formatChunk;
    sampleDataParts.push(parsedWav.sampleData);
  }

  if (!formatChunk) throw new Error("TTS returned audio without a WAV fmt chunk");

  const totalSampleDataLength = sampleDataParts.reduce((total, part) => total + part.length, 0);
  const combinedWav = new Uint8Array(12 + formatChunk.length + 8 + totalSampleDataLength);
  const combinedWavView = new DataView(combinedWav.buffer);

  combinedWav.set(new TextEncoder().encode("RIFF"), 0);
  combinedWavView.setUint32(4, combinedWav.length - 8, true);
  combinedWav.set(new TextEncoder().encode("WAVE"), 8);
  combinedWav.set(formatChunk, 12);

  const dataChunkHeaderOffset = 12 + formatChunk.length;
  combinedWav.set(new TextEncoder().encode("data"), dataChunkHeaderOffset);
  combinedWavView.setUint32(dataChunkHeaderOffset + 4, totalSampleDataLength, true);

  let writeOffset = dataChunkHeaderOffset + 8;
  for (const sampleDataPart of sampleDataParts) {
    combinedWav.set(sampleDataPart, writeOffset);
    writeOffset += sampleDataPart.length;
  }

  return combinedWav;
}

/** Returns the full `fmt ` chunk (header included) and the raw `data` payload. */
function parseWavChunks(wavFile: Uint8Array): { formatChunk: Uint8Array | null; sampleData: Uint8Array } {
  const wavView = new DataView(wavFile.buffer, wavFile.byteOffset, wavFile.byteLength);
  const readChunkId = (offset: number) => String.fromCharCode(...wavFile.subarray(offset, offset + 4));

  let formatChunk: Uint8Array | null = null;
  let readOffset = 12; // skip "RIFF" + size + "WAVE"

  while (readOffset + 8 <= wavFile.length) {
    const chunkId = readChunkId(readOffset);
    const declaredChunkSize = wavView.getUint32(readOffset + 4, true);
    const chunkPayloadStart = readOffset + 8;

    if (chunkId === "data") {
      // Streamed WAVs often declare a placeholder size (0 or 0xFFFFFFFF),
      // so trust the actual byte count when the declared size doesn't fit.
      const availableBytes = wavFile.length - chunkPayloadStart;
      const sampleDataLength =
        declaredChunkSize > 0 && declaredChunkSize <= availableBytes ? declaredChunkSize : availableBytes;
      return { formatChunk, sampleData: wavFile.subarray(chunkPayloadStart, chunkPayloadStart + sampleDataLength) };
    }

    if (chunkId === "fmt ") {
      formatChunk = wavFile.slice(readOffset, chunkPayloadStart + declaredChunkSize);
    }

    // Chunks are word-aligned: odd-sized chunks carry one padding byte
    readOffset = chunkPayloadStart + declaredChunkSize + (declaredChunkSize % 2);
  }

  throw new Error("TTS returned audio without a WAV data chunk");
}

// MARK: - /transcribe

async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  const speechProviderName = resolveSpeechProvider(env);
  if (!speechProviderName) {
    // The app falls back to on-device speech recognition on 501
    return jsonResponse({ error: "No speech-to-text provider: set GROQ_API_KEY or OPENAI_API_KEY." }, 501);
  }
  const speechProvider = SPEECH_PROVIDERS[speechProviderName];

  // The app sends an OpenAI-style multipart form (model, language, prompt,
  // file). Swap in this provider's model. OpenAI's gpt-transcribe replaced
  // the singular `language` field, so let it auto-detect instead.
  const transcriptionForm = await request.formData();
  transcriptionForm.set("model", speechProvider.transcriptionModel);
  if (speechProviderName === "openai") {
    transcriptionForm.delete("language");
  }

  const providerResponse = await fetchWithRateLimitRetry(speechProvider.transcriptionURL, {
    method: "POST",
    headers: { authorization: `Bearer ${env[speechProvider.apiKeyEnvName]}` },
    body: transcriptionForm,
  });

  const responseBody = await providerResponse.text();
  if (!providerResponse.ok) {
    console.error(`[/transcribe] ${speechProviderName} transcription error ${providerResponse.status}: ${responseBody}`);
  }

  return new Response(responseBody, {
    status: providerResponse.status,
    headers: { "content-type": "application/json" },
  });
}

// MARK: - Helpers

/**
 * fetch() that, on a 429, waits the delay the provider asks for and retries,
 * as long as the total wait stays short. The request body must be
 * re-sendable (string / ArrayBuffer), not a stream.
 */
async function fetchWithRateLimitRetry(url: string, requestInit: RequestInit): Promise<Response> {
  let totalSecondsWaited = 0;

  for (let retryNumber = 0; ; retryNumber++) {
    const groqResponse = await fetch(url, requestInit);
    if (groqResponse.status !== 429 || retryNumber >= MAX_RATE_LIMIT_RETRIES) return groqResponse;

    const requestedDelaySeconds = await readRetryDelaySeconds(groqResponse);
    if (requestedDelaySeconds === null) return groqResponse;

    // Small random stagger so requests that were limited together
    // (e.g. parallel TTS chunks) don't all retry at the same instant.
    const delaySeconds = requestedDelaySeconds + 0.5 + Math.random() * 1.5;
    if (totalSecondsWaited + delaySeconds > MAX_TOTAL_RATE_LIMIT_WAIT_SECONDS) return groqResponse;

    console.log(`[rate-limit] Asked to wait ${requestedDelaySeconds.toFixed(1)}s, retrying ${new URL(url).pathname}`);
    await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    totalSecondsWaited += delaySeconds;
  }
}

/** Reads the wait time from the `retry-after` header or a "try again in 8.1s" message (Groq). */
async function readRetryDelaySeconds(rateLimitedResponse: Response): Promise<number | null> {
  const retryAfterHeaderValue = Number(rateLimitedResponse.headers.get("retry-after"));
  if (Number.isFinite(retryAfterHeaderValue) && retryAfterHeaderValue > 0) {
    return retryAfterHeaderValue;
  }

  const errorBodyText = await rateLimitedResponse.clone().text();
  const tryAgainMatch = errorBodyText.match(/try again in (?:(\d+)m)?([\d.]+)(ms|s)/i);
  if (!tryAgainMatch) return null;

  const minutes = Number(tryAgainMatch[1] ?? 0);
  const amount = Number(tryAgainMatch[2]);
  const seconds = tryAgainMatch[3].toLowerCase() === "ms" ? amount / 1000 : amount;
  return minutes * 60 + seconds;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
