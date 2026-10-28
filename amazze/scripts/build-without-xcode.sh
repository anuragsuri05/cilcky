#!/bin/bash
# =============================================================================
# build-without-xcode.sh — Builds a local test copy of Amazze.app using only
# the Xcode Command Line Tools (Swift Package Manager + macOS SDK).
#
# For testing only. Differences from an Xcode build:
#   - no app icon / asset catalog (actool ships only with full Xcode)
#   - signed with a self-signed local certificate ("Amazze Local Dev", kept in
#     build/nox/signing) instead of an Apple Developer ID
#
# Usage:  ./scripts/build-without-xcode.sh        → build/nox/Amazze.app
#         open build/nox/Amazze.app
# =============================================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="${PROJECT_DIR}/build/nox/package"
APP_BUNDLE="${PROJECT_DIR}/build/nox/Amazze.app"

echo "📦 Preparing Swift package..."
rm -rf "${PACKAGE_DIR}/Sources"
mkdir -p "${PACKAGE_DIR}/Sources/Amazze"
cp "${PROJECT_DIR}"/Amazze/*.swift "${PACKAGE_DIR}/Sources/Amazze/"

# Mirrors the Xcode target's Swift settings: Swift 5 mode, MainActor default
# isolation, "Approachable Concurrency" and MemberImportVisibility.
cat > "${PACKAGE_DIR}/Package.swift" <<'EOF'
// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "Amazze",
    platforms: [.macOS("14.2")],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.9.0"),
        .package(url: "https://github.com/PostHog/posthog-ios.git", exact: "3.47.0"),
    ],
    targets: [
        .executableTarget(
            name: "Amazze",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "PostHog", package: "posthog-ios"),
            ],
            swiftSettings: [
                .swiftLanguageMode(.v5),
                .defaultIsolation(MainActor.self),
                .enableUpcomingFeature("DisableOutwardActorInference"),
                .enableUpcomingFeature("GlobalActorIsolatedTypesUsability"),
                .enableUpcomingFeature("InferIsolatedConformances"),
                .enableUpcomingFeature("InferSendableFromCaptures"),
                .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
                .enableUpcomingFeature("MemberImportVisibility"),
            ],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
            ]
        ),
    ]
)
EOF

echo "🔨 Compiling (first run downloads Sparkle + PostHog)..."
swift build --package-path "${PACKAGE_DIR}" -c debug
BIN_DIR="$(swift build --package-path "${PACKAGE_DIR}" -c debug --show-bin-path)"

echo "🧩 Assembling ${APP_BUNDLE}..."
rm -rf "${APP_BUNDLE}"
mkdir -p "${APP_BUNDLE}/Contents/MacOS" "${APP_BUNDLE}/Contents/Resources" "${APP_BUNDLE}/Contents/Frameworks"
cp "${BIN_DIR}/Amazze" "${APP_BUNDLE}/Contents/MacOS/Amazze"
cp "${PROJECT_DIR}"/Amazze/*.mp3 "${APP_BUNDLE}/Contents/Resources/" 2>/dev/null || true
if [ -d "${BIN_DIR}/Sparkle.framework" ]; then
    cp -R "${BIN_DIR}/Sparkle.framework" "${APP_BUNDLE}/Contents/Frameworks/"
fi
for resourceBundle in "${BIN_DIR}"/*.bundle; do
    [ -e "${resourceBundle}" ] && cp -R "${resourceBundle}" "${APP_BUNDLE}/Contents/Resources/"
done

# Info.plist = the project's Info.plist + the keys Xcode normally generates
INFO_PLIST="${APP_BUNDLE}/Contents/Info.plist"
cp "${PROJECT_DIR}/Amazze/Info.plist" "${INFO_PLIST}"
set_plist_value() {
    /usr/libexec/PlistBuddy -c "Delete :$1" "${INFO_PLIST}" >/dev/null 2>&1 || true
    /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "${INFO_PLIST}"
}
set_plist_value CFBundleExecutable string Amazze
set_plist_value CFBundleIdentifier string com.amazze.app
set_plist_value CFBundleName string Amazze
set_plist_value CFBundleDisplayName string Amazze
set_plist_value CFBundlePackageType string APPL
set_plist_value CFBundleShortVersionString string 1.0
set_plist_value CFBundleVersion string 1
set_plist_value LSMinimumSystemVersion string 14.2
set_plist_value NSPrincipalClass string NSApplication
set_plist_value NSHighResolutionCapable bool true

# Sign with a stable self-signed identity kept in its own keychain under
# build/. An ad-hoc signature changes on every build, so macOS treats each
# rebuild as a new app: granted permissions stop matching (Accessibility in
# particular). A fixed certificate keeps the app's identity — and its
# permissions — the same across rebuilds.
SIGNING_DIR="${PROJECT_DIR}/build/nox/signing"
SIGNING_KEYCHAIN="${SIGNING_DIR}/amazze-dev.keychain-db"
SIGNING_KEYCHAIN_PASSWORD="amazze"
SIGNING_IDENTITY_NAME="Amazze Local Dev"

if ! security find-identity -p codesigning "${SIGNING_KEYCHAIN}" 2>/dev/null | grep -q "${SIGNING_IDENTITY_NAME}"; then
    echo "🔑 Creating local signing identity (one time)..."
    mkdir -p "${SIGNING_DIR}"
    rm -f "${SIGNING_KEYCHAIN}"
    cat > "${SIGNING_DIR}/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = ${SIGNING_IDENTITY_NAME}
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "${SIGNING_DIR}/key.pem" -out "${SIGNING_DIR}/cert.pem" \
        -config "${SIGNING_DIR}/cert.cnf" 2>/dev/null
    # Legacy PKCS12 algorithms: the macOS keychain can't import OpenSSL 3's defaults
    openssl pkcs12 -export -legacy -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES \
        -inkey "${SIGNING_DIR}/key.pem" -in "${SIGNING_DIR}/cert.pem" \
        -name "${SIGNING_IDENTITY_NAME}" -passout "pass:${SIGNING_KEYCHAIN_PASSWORD}" \
        -out "${SIGNING_DIR}/identity.p12"
    security create-keychain -p "${SIGNING_KEYCHAIN_PASSWORD}" "${SIGNING_KEYCHAIN}"
    security set-keychain-settings "${SIGNING_KEYCHAIN}"
    security unlock-keychain -p "${SIGNING_KEYCHAIN_PASSWORD}" "${SIGNING_KEYCHAIN}"
    security import "${SIGNING_DIR}/identity.p12" -k "${SIGNING_KEYCHAIN}" \
        -P "${SIGNING_KEYCHAIN_PASSWORD}" -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
        -k "${SIGNING_KEYCHAIN_PASSWORD}" "${SIGNING_KEYCHAIN}" >/dev/null
    rm -f "${SIGNING_DIR}/key.pem" "${SIGNING_DIR}/identity.p12"
fi

echo "✍️  Signing with \"${SIGNING_IDENTITY_NAME}\"..."
security unlock-keychain -p "${SIGNING_KEYCHAIN_PASSWORD}" "${SIGNING_KEYCHAIN}"

# codesign only finds identities in keychains on the search list, so add ours
# for the duration of signing and always restore the user's original list.
ORIGINAL_KEYCHAINS=()
while IFS= read -r keychainPath; do
    keychainPath="${keychainPath#"${keychainPath%%[![:space:]]*}"}"
    keychainPath="${keychainPath#\"}"; keychainPath="${keychainPath%\"}"
    [ -n "${keychainPath}" ] && ORIGINAL_KEYCHAINS+=("${keychainPath}")
done < <(security list-keychains -d user)
restore_keychain_search_list() {
    security list-keychains -d user -s "${ORIGINAL_KEYCHAINS[@]}"
}
trap restore_keychain_search_list EXIT
security list-keychains -d user -s "${ORIGINAL_KEYCHAINS[@]}" "${SIGNING_KEYCHAIN}"

if [ -d "${APP_BUNDLE}/Contents/Frameworks/Sparkle.framework" ]; then
    codesign --force --deep --sign "${SIGNING_IDENTITY_NAME}" "${APP_BUNDLE}/Contents/Frameworks/Sparkle.framework"
fi
codesign --force --sign "${SIGNING_IDENTITY_NAME}" \
    --entitlements "${PROJECT_DIR}/Amazze/Amazze.entitlements" "${APP_BUNDLE}"
restore_keychain_search_list
trap - EXIT

echo "✅ Built ${APP_BUNDLE}"
echo "   Start the Worker first:  cd worker && npx wrangler dev"
echo "   Then:                    open \"${APP_BUNDLE}\""
