import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Stable versions have a deterministic ordering across workflows and reruns. */
export function androidReleaseVersion(value) {
  const match = /^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (!match || match[0] !== value) throw new Error("Expected a stable major.minor.patch Android release version");
  const [major, minor, patch] = match.slice(1).map(Number);
  if (!Number.isSafeInteger(major) || major > 2099 || minor > 999 || patch > 999) {
    throw new Error("Android release version is outside the versionCode range");
  }
  return { versionName: match.slice(1).join("."), versionCode: major * 1_000_000 + minor * 1_000 + patch + 1 };
}

/** apksigner must have verified the signature successfully before this check. */
export function verifyReleaseMetadata(badging, certificates, version, expectedCertificate) {
  const expected = androidReleaseVersion(version);
  if (!/^[a-fA-F0-9]{64}$/.test(expectedCertificate)) throw new Error("Expected a SHA-256 signing certificate fingerprint");
  const manifest = /^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'/m.exec(badging);
  if (!manifest || manifest[1] !== "ai.lankford.ompui.android") throw new Error("APK has the wrong application ID or missing package metadata");
  if (Number(manifest[2]) !== expected.versionCode || manifest[3] !== expected.versionName) {
    throw new Error("APK version does not match the release tag");
  }
  if (/^application-debuggable(?:\s|$)/m.test(badging)) throw new Error("Release APK must not be debuggable");
  const signers = [...certificates.matchAll(/^Signer #[0-9]+ certificate SHA-256 digest: ([a-fA-F0-9]{64})\s*$/gm)];
  if (signers.length !== 1 || signers[0][1].toLowerCase() !== expectedCertificate.toLowerCase()) {
    throw new Error("APK signing certificate does not match the pinned release identity");
  }
  return { applicationId: manifest[1], ...expected, certificateSha256: expectedCertificate.toLowerCase() };
}

export function verifyReleaseApk(apk, version, expectedCertificate, sdkRoot) {
  if (!sdkRoot) throw new Error("Set ANDROID_HOME or ANDROID_SDK_ROOT to verify the release APK");
  // Match app/build.gradle.kts and the workflow's explicitly installed build tools.
  const tools = path.join(sdkRoot, "build-tools", "36.0.0");
  const certificates = execFileSync(path.join(tools, "apksigner"), ["verify", "--verbose", "--print-certs", apk], { encoding: "utf8" });
  const badging = execFileSync(path.join(tools, "aapt"), ["dump", "badging", apk], { encoding: "utf8" });
  return verifyReleaseMetadata(badging, certificates, version, expectedCertificate);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [apk, version, certificate] = process.argv.slice(2);
    if (process.argv.length !== 5) throw new Error("Usage: node android/scripts/verify-release.mjs APK VERSION CERTIFICATE_SHA256");
    const result = verifyReleaseApk(apk, version, certificate, process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
