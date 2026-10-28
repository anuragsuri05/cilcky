//
//  AppBundleConfiguration.swift
//  Amazze
//
//  Shared helper for reading runtime configuration from the built app bundle.
//

import Foundation

enum AppBundleConfiguration {
    /// Base URL of the Amazze Cloudflare Worker proxy (`AmazzeWorkerBaseURL`
    /// in Info.plist). Every AI request goes through it so the Groq key
    /// never ships in the app binary. Defaults to a local `wrangler dev`.
    static var workerBaseURL: String {
        let configuredWorkerBaseURL = stringValue(forKey: "AmazzeWorkerBaseURL") ?? "http://localhost:8787"
        return configuredWorkerBaseURL.hasSuffix("/")
            ? String(configuredWorkerBaseURL.dropLast())
            : configuredWorkerBaseURL
    }

    static func stringValue(forKey key: String) -> String? {
        if let value = Bundle.main.object(forInfoDictionaryKey: key) as? String {
            let trimmedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedValue.isEmpty {
                return trimmedValue
            }
        }

        guard let resourceInfoPath = Bundle.main.path(forResource: "Info", ofType: "plist"),
              let resourceInfo = NSDictionary(contentsOfFile: resourceInfoPath),
              let value = resourceInfo[key] as? String else {
            return nil
        }

        let trimmedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedValue.isEmpty ? nil : trimmedValue
    }
}
