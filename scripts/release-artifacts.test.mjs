import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { planReleaseManifest } from "./release-artifacts.mjs";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("./release-artifacts.mjs", import.meta.url));
const version = "1.2.3";

const fixtures = {
  linux: {
    target: { platform: "linux", version, arches: ["x64", "arm64", "armv7l"] },
    names: [
      "omp-ui-1.2.3-x64.AppImage",
      "omp-ui_1.2.3_amd64.deb",
      "omp-ui-1.2.3-arm64.AppImage",
      "omp-ui_1.2.3_arm64.deb",
      "omp-ui-1.2.3-armv7l.AppImage",
      "omp-ui_1.2.3_armhf.deb",
    ],
  },
  mac: {
    target: { platform: "mac", version, arches: ["arm64", "x64"] },
    names: [
      "omp-ui-1.2.3-mac-preview-arm64.dmg",
      "omp-ui-1.2.3-mac-preview-arm64.zip",
      "omp-ui-1.2.3-mac-preview-x64.dmg",
      "omp-ui-1.2.3-mac-preview-x64.zip",
    ],
  },
  win: {
    target: { platform: "win", version, arches: ["x64", "arm64", "ia32"] },
    names: [
      "omp-ui-1.2.3-windows-preview-x64-setup.exe",
      "omp-ui-1.2.3-windows-preview-arm64-setup.exe",
      "omp-ui-1.2.3-windows-preview-ia32-setup.exe",
    ],
  },
};

function metadata(names) {
  return names.map((name, index) => ({ name, size: index + 1 }));
}

function sorted(names) {
  return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

for (const [platform, fixture] of Object.entries(fixtures)) {
  test(`plans every ${platform} architecture and artifact kind`, () => {
    const plan = planReleaseManifest(metadata(fixture.names), fixture.target);

    assert.deepEqual(plan.checksumInputs, sorted(fixture.names));
    assert.equal(plan.artifacts.length, fixture.names.length);
    assert.deepEqual(new Set(plan.artifacts.map(({ arch }) => arch)), new Set(fixture.target.arches));
    if (platform === "linux") {
      assert.deepEqual(new Set(plan.artifacts.map(({ kind }) => kind)), new Set(["appimage", "deb"]));
    } else if (platform === "mac") {
      assert.deepEqual(plan.latestMac, {
        version,
        files: [
          { url: fixture.names[0], size: 1 },
          { url: fixture.names[1], size: 2 },
          { url: fixture.names[2], size: 3 },
          { url: fixture.names[3], size: 4 },
        ],
        path: fixture.names[0],
      });
    } else {
      assert.deepEqual(new Set(plan.artifacts.map(({ kind }) => kind)), new Set(["nsis"]));
    }
  });
}

test("rejects a missing requested architecture", () => {
  const fixture = fixtures.linux;
  const files = metadata(fixture.names).filter(({ name }) => !name.endsWith("armv7l.AppImage"));

  assert.throws(
    () => planReleaseManifest(files, fixture.target),
    /Missing linux artifacts: armv7l appimage/,
  );
});

test("rejects duplicate artifacts for an architecture", () => {
  const fixture = fixtures.linux;
  const files = [
    ...metadata(fixture.names),
    { name: "omp-ui_1.2.3_x64.AppImage", size: 99 },
  ];

  assert.throws(
    () => planReleaseManifest(files, fixture.target),
    /Duplicate linux appimage artifact for x64/,
  );
});

async function writeFixture(t, fixture) {
  const root = await mkdtemp(path.join(tmpdir(), "release-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "dist");
  const outDir = path.join(root, "manifest");
  await mkdir(dir);
  await Promise.all(
    fixture.names.map((name, index) => writeFile(path.join(dir, name), Buffer.alloc(index + 1, index))),
  );
  return { dir, outDir };
}

async function runCli(fixture, paths) {
  return execFileAsync(process.execPath, [
    script,
    "--dir",
    paths.dir,
    "--platform",
    fixture.target.platform,
    "--version",
    fixture.target.version,
    "--arches",
    fixture.target.arches.join(","),
    "--out-dir",
    paths.outDir,
  ]);
}

for (const [platform, fixture] of Object.entries(fixtures)) {
  test(`CLI plans real ${platform} files and writes checksum inputs`, async (t) => {
    const paths = await writeFixture(t, fixture);
    const { stdout } = await runCli(fixture, paths);
    const plan = JSON.parse(stdout);

    assert.deepEqual(plan.checksumInputs, sorted(fixture.names));
    assert.equal(
      await readFile(path.join(paths.outDir, "checksum-inputs.txt"), "utf8"),
      `${sorted(fixture.names).join("\n")}\n`,
    );

    if (platform === "mac") {
      const latestMac = await readFile(path.join(paths.outDir, "latest-mac.yml"), "utf8");
      const primary = fixture.names[0];
      const primaryHash = createHash("sha512").update(Buffer.alloc(1, 0)).digest("base64");
      assert.match(latestMac, /^version: 1\.2\.3\nfiles:\n/);
      for (const name of fixture.names) assert.match(latestMac, new RegExp(`  - url: ${name}`));
      assert.ok(latestMac.includes(`path: ${primary}\nsha512: ${primaryHash}`));
      assert.match(latestMac, /releaseDate: '\d{4}-\d\d-\d\dT[^']+'\n$/);
    } else {
      await assert.rejects(readFile(path.join(paths.outDir, "latest-mac.yml")), /ENOENT/);
    }
  });
}

test("CLI rejects missing and duplicate artifacts", async (t) => {
  for (const extraName of [null, "omp-ui_1.2.3_x64.AppImage"]) {
    const fixture = {
      ...fixtures.linux,
      names: extraName
        ? [...fixtures.linux.names, extraName]
        : fixtures.linux.names.filter((name) => !name.endsWith("armv7l.AppImage")),
    };
    const paths = await writeFixture(t, fixture);
    await assert.rejects(
      runCli(fixture, paths),
      extraName ? /Duplicate linux appimage artifact for x64/ : /Missing linux artifacts: armv7l appimage/,
    );
  }
});
