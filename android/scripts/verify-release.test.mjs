import assert from "node:assert/strict";
import test from "node:test";
import { androidReleaseVersion, verifyReleaseMetadata } from "./verify-release.mjs";

const fingerprint = "a".repeat(64);
const signer = `Signer #1 certificate SHA-256 digest: ${fingerprint}\n`;
const manifest = "package: name='ai.lankford.ompui.android' versionCode='1002004' versionName='1.2.3' platformBuildVersionName='16'\napplication-label:'omp-ui'\n";

test("version codes remain ordered across patch, minor, and major releases", () => {
  const values = ["0.0.0", "0.0.999", "0.1.0", "0.999.999", "1.0.0", "2099.999.999"].map(androidReleaseVersion);
  assert.equal(values[0].versionCode, 1);
  assert.equal(values.at(-1).versionCode, 2_100_000_000);
  for (let i = 1; i < values.length; i++) assert.ok(values[i].versionCode > values[i - 1].versionCode);
  assert.deepEqual(androidReleaseVersion("v1.2.3"), { versionName: "1.2.3", versionCode: 1_002_004 });
});

test("refuses ambiguous, prerelease, and out-of-range release versions", () => {
  for (const value of ["1.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-nightly.1", "1.2.3+build", "1.2.3\n", "2100.0.0", "1.1000.0", "1.0.1000", "9999999999999999999999.0.0"]) {
    assert.throws(() => androidReleaseVersion(value), /stable|range/);
  }
});

test("admits the exact package, release version, and signing identity", () => {
  assert.deepEqual(verifyReleaseMetadata(manifest, signer, "v1.2.3", fingerprint.toUpperCase()), {
    applicationId: "ai.lankford.ompui.android", versionName: "1.2.3", versionCode: 1_002_004, certificateSha256: fingerprint,
  });
});

test("refuses debug builds, wrong application IDs, and mismatched version metadata", () => {
  for (const badging of [
    `${manifest}application-debuggable\n`,
    manifest.replace("ai.lankford.ompui.android", "other.app"),
    manifest.replace("1002004", "1002003"),
    manifest.replace("versionName='1.2.3'", "versionName='1.2.4'"),
    "",
  ]) assert.throws(() => verifyReleaseMetadata(badging, signer, "1.2.3", fingerprint), /debuggable|application ID|version/);
});

test("refuses missing, multiple, malformed, and unexpected signing identities", () => {
  for (const certificates of ["", signer.replace(fingerprint, "b".repeat(64)), signer + signer.replace("#1", "#2")]) {
    assert.throws(() => verifyReleaseMetadata(manifest, certificates, "1.2.3", fingerprint), /signing certificate/);
  }
  assert.throws(() => verifyReleaseMetadata(manifest, signer, "1.2.3", "not-a-fingerprint"), /fingerprint/);
});
