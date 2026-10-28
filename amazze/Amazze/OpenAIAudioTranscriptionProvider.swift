//
//  OpenAIAudioTranscriptionProvider.swift
//  Amazze
//
//  AI transcription provider backed by an OpenAI-compatible audio
//  transcription API: OpenAI directly, or the Amazze Worker's `/transcribe`
//  route (Groq Whisper or OpenAI, whichever key the Worker has). When the
//  Worker has no speech provider it answers 501 and the recording is
//  transcribed on-device with Apple's Speech framework instead.
//

import AVFoundation
import Foundation
import Speech

struct OpenAIAudioTranscriptionProviderError: LocalizedError {
    let message: String

    var errorDescription: String? {
        message
    }
}

/// The Worker answered 501: none of its API keys offer speech-to-text.
private struct WorkerHasNoSpeechToTextProviderError: Error {}

final class OpenAIAudioTranscriptionProvider: BuddyTranscriptionProvider {
    private let transcriptionURL: URL
    private let apiKey: String?
    private let modelName: String
    /// The Worker route holds its own key, so only direct OpenAI calls need one here.
    private let requiresAPIKeyInApp: Bool

    let displayName: String
    let requiresSpeechRecognitionPermission = false

    /// Calls OpenAI directly with `OpenAIAPIKey` from Info.plist.
    init() {
        self.transcriptionURL = URL(string: "https://api.openai.com/v1/audio/transcriptions")!
        self.apiKey = AppBundleConfiguration.stringValue(forKey: "OpenAIAPIKey")
        self.modelName = AppBundleConfiguration.stringValue(forKey: "OpenAITranscriptionModel")
            ?? "gpt-4o-transcribe"
        self.requiresAPIKeyInApp = true
        self.displayName = "OpenAI"
    }

    private init(transcriptionURL: URL, modelName: String, displayName: String) {
        self.transcriptionURL = transcriptionURL
        self.apiKey = nil
        self.modelName = modelName
        self.requiresAPIKeyInApp = false
        self.displayName = displayName
    }

    /// The Worker's `/transcribe` route, which picks the speech provider
    /// (Groq or OpenAI) and adds its key server-side. The model field sent
    /// from here is replaced by the Worker.
    static func transcriptionThroughWorker() -> OpenAIAudioTranscriptionProvider {
        OpenAIAudioTranscriptionProvider(
            transcriptionURL: URL(string: "\(AppBundleConfiguration.workerBaseURL)/transcribe")!,
            modelName: "whisper-large-v3-turbo",
            displayName: "Amazze Worker"
        )
    }

    var isConfigured: Bool {
        !requiresAPIKeyInApp || apiKey != nil
    }

    var unavailableExplanation: String? {
        guard !isConfigured else { return nil }
        return "OpenAI transcription is not configured. Add OpenAIAPIKey to Info.plist."
    }

    func startStreamingSession(
        keyterms: [String],
        onTranscriptUpdate: @escaping (String) -> Void,
        onFinalTranscriptReady: @escaping (String) -> Void,
        onError: @escaping (Error) -> Void
    ) async throws -> any BuddyStreamingTranscriptionSession {
        guard isConfigured else {
            throw OpenAIAudioTranscriptionProviderError(
                message: unavailableExplanation ?? "OpenAI transcription is not configured."
            )
        }

        return OpenAIAudioTranscriptionSession(
            transcriptionURL: transcriptionURL,
            apiKey: apiKey,
            modelName: modelName,
            keyterms: keyterms,
            onTranscriptUpdate: onTranscriptUpdate,
            onFinalTranscriptReady: onFinalTranscriptReady,
            onError: onError
        )
    }
}

private final class OpenAIAudioTranscriptionSession: BuddyStreamingTranscriptionSession {
    let finalTranscriptFallbackDelaySeconds: TimeInterval = 8.0

    private struct TranscriptionResponse: Decodable {
        let text: String
    }

    private static let targetSampleRate = 16_000

    private let transcriptionURL: URL
    private let apiKey: String?
    private let modelName: String
    private let keyterms: [String]
    private let onTranscriptUpdate: (String) -> Void
    private let onFinalTranscriptReady: (String) -> Void
    private let onError: (Error) -> Void

    private let stateQueue = DispatchQueue(label: "com.amazze.openai.transcription")
    private let audioPCM16Converter = BuddyPCM16AudioConverter(
        targetSampleRate: Double(targetSampleRate)
    )
    private let urlSession: URLSession

    private var bufferedPCM16AudioData = Data()
    private var hasRequestedFinalTranscript = false
    private var hasDeliveredFinalTranscript = false
    private var isCancelled = false
    private var transcriptionUploadTask: Task<Void, Never>?

    init(
        transcriptionURL: URL,
        apiKey: String?,
        modelName: String,
        keyterms: [String],
        onTranscriptUpdate: @escaping (String) -> Void,
        onFinalTranscriptReady: @escaping (String) -> Void,
        onError: @escaping (Error) -> Void
    ) {
        self.transcriptionURL = transcriptionURL
        self.apiKey = apiKey
        self.modelName = modelName
        self.keyterms = keyterms
        self.onTranscriptUpdate = onTranscriptUpdate
        self.onFinalTranscriptReady = onFinalTranscriptReady
        self.onError = onError

        let urlSessionConfiguration = URLSessionConfiguration.default
        urlSessionConfiguration.timeoutIntervalForRequest = 45
        urlSessionConfiguration.timeoutIntervalForResource = 90
        urlSessionConfiguration.waitsForConnectivity = true
        self.urlSession = URLSession(configuration: urlSessionConfiguration)
    }

    func appendAudioBuffer(_ audioBuffer: AVAudioPCMBuffer) {
        guard let audioPCM16Data = audioPCM16Converter.convertToPCM16Data(from: audioBuffer),
              !audioPCM16Data.isEmpty else {
            return
        }

        stateQueue.async {
            guard !self.hasRequestedFinalTranscript, !self.isCancelled else { return }
            self.bufferedPCM16AudioData.append(audioPCM16Data)
        }
    }

    func requestFinalTranscript() {
        stateQueue.async {
            guard !self.hasRequestedFinalTranscript, !self.isCancelled else { return }
            self.hasRequestedFinalTranscript = true

            let bufferedPCM16AudioData = self.bufferedPCM16AudioData
            self.transcriptionUploadTask = Task { [weak self] in
                await self?.transcribeBufferedAudio(bufferedPCM16AudioData)
            }
        }
    }

    func cancel() {
        stateQueue.async {
            self.isCancelled = true
            self.bufferedPCM16AudioData.removeAll(keepingCapacity: false)
        }

        transcriptionUploadTask?.cancel()
        urlSession.invalidateAndCancel()
    }

    private func transcribeBufferedAudio(_ bufferedPCM16AudioData: Data) async {
        guard !Task.isCancelled else { return }

        let trimmedAudioDataIsEmpty = stateQueue.sync {
            isCancelled || bufferedPCM16AudioData.isEmpty
        }

        if trimmedAudioDataIsEmpty {
            deliverFinalTranscript("")
            return
        }

        let wavAudioData = BuddyWAVFileBuilder.buildWAVData(
            fromPCM16MonoAudio: bufferedPCM16AudioData,
            sampleRate: Self.targetSampleRate
        )

        do {
            let transcriptText: String
            do {
                transcriptText = try await requestTranscription(for: wavAudioData)
            } catch is WorkerHasNoSpeechToTextProviderError {
                print("[OpenAI Transcription] Worker has no speech-to-text key — transcribing on-device")
                transcriptText = try await transcribeOnDevice(wavAudioData: wavAudioData)
            }
            guard !stateQueue.sync(execute: { isCancelled }) else { return }

            if !transcriptText.isEmpty {
                onTranscriptUpdate(transcriptText)
            }

            deliverFinalTranscript(transcriptText)
        } catch {
            guard !stateQueue.sync(execute: { isCancelled }) else { return }
            print("[OpenAI Transcription] ❌ Upload failed (audio size: \(wavAudioData.count) bytes): \(error.localizedDescription)")
            onError(error)
        }
    }

    private func requestTranscription(for wavAudioData: Data) async throws -> String {
        let multipartBoundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: transcriptionURL)
        request.httpMethod = "POST"
        if let apiKey {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("multipart/form-data; boundary=\(multipartBoundary)", forHTTPHeaderField: "Content-Type")

        let requestBodyData = makeMultipartRequestBody(
            boundary: multipartBoundary,
            wavAudioData: wavAudioData
        )
        request.httpBody = requestBodyData

        let (responseData, response) = try await urlSession.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw OpenAIAudioTranscriptionProviderError(
                message: "OpenAI transcription returned an invalid response."
            )
        }

        if httpResponse.statusCode == 501 {
            throw WorkerHasNoSpeechToTextProviderError()
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            let responseText = String(data: responseData, encoding: .utf8) ?? "Unknown error"
            throw OpenAIAudioTranscriptionProviderError(
                message: "OpenAI transcription failed: \(responseText)"
            )
        }

        if let transcriptionResponse = try? JSONDecoder().decode(
            TranscriptionResponse.self,
            from: responseData
        ) {
            return transcriptionResponse.text.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let responseText = String(data: responseData, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if !responseText.isEmpty {
            return responseText
        }

        throw OpenAIAudioTranscriptionProviderError(
            message: "OpenAI transcription returned an empty transcript."
        )
    }

    private func makeMultipartRequestBody(
        boundary: String,
        wavAudioData: Data
    ) -> Data {
        var requestBodyData = Data()

        requestBodyData.appendMultipartFormField(
            named: "model",
            value: modelName,
            usingBoundary: boundary
        )
        requestBodyData.appendMultipartFormField(
            named: "language",
            value: "en",
            usingBoundary: boundary
        )
        requestBodyData.appendMultipartFormField(
            named: "response_format",
            value: "json",
            usingBoundary: boundary
        )

        if let contextualPrompt = transcriptionPromptText() {
            requestBodyData.appendMultipartFormField(
                named: "prompt",
                value: contextualPrompt,
                usingBoundary: boundary
            )
        }

        requestBodyData.appendMultipartFileField(
            named: "file",
            filename: "voice-input.wav",
            mimeType: "audio/wav",
            fileData: wavAudioData,
            usingBoundary: boundary
        )
        requestBodyData.appendString("--\(boundary)--\r\n")

        return requestBodyData
    }

    private func transcriptionPromptText() -> String? {
        let normalizedKeyterms = keyterms
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        guard !normalizedKeyterms.isEmpty else { return nil }

        return """
        This is a short push-to-talk transcript for a coding and product app. Expect product names, technical terms, and app-specific vocabulary such as: \(normalizedKeyterms.joined(separator: ", ")).
        """
    }

    /// Transcribes the recorded push-to-talk audio with Apple's Speech
    /// framework (on-device when the Mac supports it). Used when the Worker
    /// has no Groq or OpenAI key for cloud speech-to-text.
    private func transcribeOnDevice(wavAudioData: Data) async throws -> String {
        let speechAuthorizationStatus: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { authorizationStatus in
                continuation.resume(returning: authorizationStatus)
            }
        }
        guard speechAuthorizationStatus == .authorized else {
            throw OpenAIAudioTranscriptionProviderError(
                message: "Speech recognition permission is needed when the Amazze worker has no Groq or OpenAI key."
            )
        }

        guard let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              speechRecognizer.isAvailable else {
            throw OpenAIAudioTranscriptionProviderError(message: "On-device speech recognition is unavailable.")
        }

        let temporaryAudioFileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("amazze-voice-\(UUID().uuidString).wav")
        try wavAudioData.write(to: temporaryAudioFileURL)
        defer { try? FileManager.default.removeItem(at: temporaryAudioFileURL) }

        let recognitionRequest = SFSpeechURLRecognitionRequest(url: temporaryAudioFileURL)
        recognitionRequest.shouldReportPartialResults = false
        recognitionRequest.requiresOnDeviceRecognition = speechRecognizer.supportsOnDeviceRecognition
        recognitionRequest.contextualStrings = keyterms

        return try await withCheckedThrowingContinuation { continuation in
            var hasResumedContinuation = false
            speechRecognizer.recognitionTask(with: recognitionRequest) { recognitionResult, recognitionError in
                guard !hasResumedContinuation else { return }
                if let recognitionResult, recognitionResult.isFinal {
                    hasResumedContinuation = true
                    continuation.resume(returning: recognitionResult.bestTranscription.formattedString)
                } else if let recognitionError {
                    hasResumedContinuation = true
                    continuation.resume(throwing: recognitionError)
                }
            }
        }
    }

    private func deliverFinalTranscript(_ transcriptText: String) {
        guard !hasDeliveredFinalTranscript else { return }
        hasDeliveredFinalTranscript = true
        onFinalTranscriptReady(transcriptText)
    }

    deinit {
        // Don't call cancel() here: it enqueues a closure that captures self,
        // which would outlive deinit and crash ("deallocated with non-zero
        // retain count"). The buffered audio is freed with the object anyway.
        transcriptionUploadTask?.cancel()
        urlSession.invalidateAndCancel()
    }
}

private extension Data {
    mutating func appendString(_ string: String) {
        append(string.data(using: .utf8)!)
    }

    mutating func appendMultipartFormField(
        named fieldName: String,
        value: String,
        usingBoundary boundary: String
    ) {
        appendString("--\(boundary)\r\n")
        appendString("Content-Disposition: form-data; name=\"\(fieldName)\"\r\n\r\n")
        appendString("\(value)\r\n")
    }

    mutating func appendMultipartFileField(
        named fieldName: String,
        filename: String,
        mimeType: String,
        fileData: Data,
        usingBoundary boundary: String
    ) {
        appendString("--\(boundary)\r\n")
        appendString("Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(filename)\"\r\n")
        appendString("Content-Type: \(mimeType)\r\n\r\n")
        append(fileData)
        appendString("\r\n")
    }
}
