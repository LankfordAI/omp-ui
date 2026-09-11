import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderHostFeed } from "./host-feed.mjs";
import { planReleaseManifest } from "./release-artifacts.mjs";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("./release-artifacts.mjs", import.meta.url));
const feedScript = fileURLToPath(new URL("./host-feed.mjs", import.meta.url));
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
      "omp-ui-host-1.2.3-linux-x64.tar.gz",
      "omp-ui-host-1.2.3-linux-arm64.tar.gz",
      "omp-ui-host-1.2.3-linux-armv7l.tar.gz",
      "latest-host-linux.yml",
    ],
  },
  mac: {
    target: { platform: "mac", version, arches: ["arm64", "x64"] },
    names: [
      "omp-ui-1.2.3-mac-preview-arm64.dmg",
      "omp-ui-1.2.3-mac-preview-arm64.zip",
      "omp-ui-1.2.3-mac-preview-x64.dmg",
      "omp-ui-1.2.3-mac-preview-x64.zip",
      "omp-ui-host-1.2.3-mac-arm64.zip",
      "omp-ui-host-1.2.3-mac-x64.zip",
      "latest-host-mac.yml",
    ],
  },
  win: {
    target: { platform: "win", version, arches: ["x64", "arm64", "ia32"] },
    names: [
      "omp-ui-1.2.3-windows-preview-x64-setup.exe",
      "omp-ui-1.2.3-windows-preview-arm64-setup.exe",
      "omp-ui-1.2.3-windows-preview-ia32-setup.exe",
      "omp-ui-host-1.2.3-win-x64.zip",
      "omp-ui-host-1.2.3-win-arm64.zip",
      "omp-ui-host-1.2.3-win-ia32.zip",
      "latest-host-win.yml",
    ],
  },
};

const HOST_EXT = { linux: "tar.gz", mac: "zip", win: "zip" };

function hostArchiveName(platform, arch) {
  return `omp-ui-host-${version}-${platform}-${arch}.${HOST_EXT[platform]}`;
}

/** `{ name, size }` per fixture name; the size is the name's index + 1 so records can quote it. */
function metadata(names) {
  return names.map((name, index) => ({ name, size: index + 1 }));
}

function sorted(names) {
  return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sizeOf(fixture, name) {
  return fixture.names.indexOf(name) + 1;
}

function fixtureBytes(fixture, name) {
  const index = fixture.names.indexOf(name);
  return Buffer.alloc(index + 1, index);
}

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const step = (name, exitCode, expectedExitCode = exitCode) => ({
  name,
  exitCode,
  expectedExitCode,
  startedAtMs: 1_700_000_000_000,
  endedAtMs: 1_700_000_001_000,
});

/** A complete host-package record for one arch, coherent with the fixture archive. */
function packageRecord(fixture, arch, overrides = {}) {
  const { platform } = fixture.target;
  const name = hostArchiveName(platform, arch);
  return {
    schemaVersion: 1,
    kind: "host-package",
    releaseTag: `v${version}`,
    platform,
    arch,
    lane: `${platform}-${arch}`,
    source: "packaged",
    artifact: { name, size: sizeOf(fixture, name), sha256: sha256Of(fixtureBytes(fixture, name)) },
    versions: {
      host: version,
      desktop: version,
      omp: null,
      protocol: 2,
      protocolRange: { min: 1, max: 2 },
      node: "22.23.2",
      abi: 127,
    },
    service: { file: "omp-ui-host.service", sha256: "a".repeat(64) },
    credentials: { backend: "linux-secret-service", outcome: "available" },
    verifier: { state: "ready", reason: null, pin: "153.0.8010.36", sha256: "b".repeat(64) },
    startedAt: "2026-09-10T12:00:00.000Z",
    finishedAt: "2026-09-10T12:01:00.000Z",
    skipped: [],
    steps: [step("--version prints the packaged version", 0), step("status --json against an empty data root reports absent", 3), step("serve", 0)],
    logs: { dir: "/records", serve: "record.serve.log" },
    ...overrides,
  };
}

/** Every record the platform needs, named as the workflow artifacts are. */
function records(fixture) {
  const { platform } = fixture.target;
  const all = fixture.target.arches.map((arch) => ({
    name: `package-record-${platform}-${arch}.json`,
    record: packageRecord(fixture, arch),
  }));
  return all;
}

for (const [platform, fixture] of Object.entries(fixtures)) {
  test(`plans every ${platform} architecture, host archive, and feed`, () => {
    const plan = planReleaseManifest(metadata(fixture.names), fixture.target, records(fixture));

    assert.deepEqual(plan.checksumInputs, sorted(fixture.names.filter((name) => !name.endsWith(".yml"))));
    assert.equal(plan.artifacts.length, fixture.names.length);
    assert.deepEqual(
      new Set(plan.artifacts.filter(({ kind }) => kind !== "host-feed").map(({ arch }) => arch)),
      new Set(fixture.target.arches),
    );
    assert.deepEqual(
      plan.artifacts.filter(({ kind }) => kind === "host-feed").map(({ name, arch }) => ({ name, arch })),
      [{ name: `latest-host-${platform}.yml`, arch: null }],
    );
    assert.deepEqual(
      plan.evidence.packages,
      fixture.target.arches.map((arch) => `package-record-${platform}-${arch}.json`),
    );
    assert.deepEqual(plan.evidence.gates, []);
    if (platform === "linux") {
      assert.deepEqual(new Set(plan.artifacts.map(({ kind }) => kind)), new Set(["appimage", "deb", "host", "host-feed"]));
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
      assert.deepEqual(new Set(plan.artifacts.map(({ kind }) => kind)), new Set(["nsis", "host", "host-feed"]));
    }
  });
}

test("ignores host artifacts, feeds, and records for other platforms", () => {
  const fixture = fixtures.linux;
  const foreign = [...fixtures.mac.names, ...fixtures.win.names].filter((name) => name.includes("host"));
  const plan = planReleaseManifest(
    metadata([...fixture.names, ...foreign]),
    fixture.target,
    [...records(fixture), ...records(fixtures.mac), ...records(fixtures.win)],
  );

  assert.deepEqual(plan.checksumInputs, sorted(fixture.names.filter((name) => !name.endsWith(".yml"))));
});

test("rejects a missing requested architecture, host archive, or feed", () => {
  const fixture = fixtures.linux;
  for (const [suffix, missing] of [
    ["armv7l.AppImage", "armv7l appimage"],
    ["linux-arm64.tar.gz", "arm64 host"],
    ["latest-host-linux.yml", "host-feed"],
  ]) {
    const files = metadata(fixture.names).filter(({ name }) => !name.endsWith(suffix));
    assert.throws(
      () => planReleaseManifest(files, fixture.target, records(fixture)),
      new RegExp(`Missing linux artifacts: ${missing}`),
    );
  }
});

test("rejects duplicate artifacts for an architecture", () => {
  const fixture = fixtures.linux;
  const files = [
    ...metadata(fixture.names),
    { name: "omp-ui_1.2.3_x64.AppImage", size: 99 },
  ];

  assert.throws(
    () => planReleaseManifest(files, fixture.target, records(fixture)),
    /Duplicate linux appimage artifact for x64/,
  );
});

test("requires one host-package record per architecture", () => {
  const fixture = fixtures.linux;
  const files = metadata(fixture.names);

  assert.throws(() => planReleaseManifest(files, fixture.target), /Missing linux records: x64 host-package, arm64 host-package, armv7l host-package/);
  assert.throws(
    () => planReleaseManifest(files, fixture.target, records(fixture).filter(({ record }) => record.arch !== "arm64" || record.kind !== "host-package")),
    /Missing linux records: arm64 host-package/,
  );
  assert.throws(
    () => planReleaseManifest(files, fixture.target, [...records(fixture), { name: "again.json", record: packageRecord(fixture, "x64") }]),
    /Duplicate linux host-package record for x64: package-record-linux-x64.json, again.json/,
  );
  assert.throws(
    () => planReleaseManifest(files, fixture.target, [...records(fixture), { name: "odd.json", record: { kind: "something-else" } }]),
    /Record odd.json: unknown record kind "something-else"/,
  );
});

test("rejects records that skipped, ran from the source tree, or name the wrong arch or asset", () => {
  const fixture = fixtures.mac;
  const files = metadata(fixture.names);
  const withX64 = (overrides) => [
    ...records(fixture).filter(({ record }) => record.arch !== "x64"),
    { name: "package-record-mac-x64.json", record: packageRecord(fixture, "x64", overrides) },
  ];
  const cases = [
    [{ skipped: ["lib/node-pty loads inside the executable"] }, /skipped lib\/node-pty loads inside the executable/],
    [{ source: "source-tree" }, /evidence from a source-tree run is not release evidence/],
    [{ arch: "ia32" }, /unexpected mac arch ia32/],
    [{ releaseTag: "v1.2.4" }, /invalid releaseTag/],
    [{ versions: { ...packageRecord(fixture, "x64").versions, host: "1.2.2" } }, /invalid versions.host/],
    [{ artifact: { ...packageRecord(fixture, "x64").artifact, name: hostArchiveName("mac", "arm64") } }, /names omp-ui-host-1.2.3-mac-arm64.zip, the release ships omp-ui-host-1.2.3-mac-x64.zip/],
    [{ artifact: { ...packageRecord(fixture, "x64").artifact, size: 999 } }, /999 bytes in the record/],
    [{ artifact: { ...packageRecord(fixture, "x64").artifact, sha256: "c".repeat(64) } }, /SHA-256 c{64} does not match the release asset/],
    [{ verifier: { state: "degraded", reason: "no browser", pin: null, sha256: null } }, /verifier degraded: no browser/],
    [{ credentials: { backend: "unavailable", outcome: "plaintext" } }, /invalid credentials.outcome/],
    [{ steps: [step("stop", 1, 0)] }, /step stop exited 1, expected 0/],
    [{ steps: [] }, /invalid steps/],
    [{ service: { file: "", sha256: "a".repeat(64) } }, /invalid service.file/],
  ];
  const hashed = files.map((file) => ({
    ...file,
    sha256: file.name.startsWith("omp-ui-host-") ? sha256Of(fixtureBytes(fixture, file.name)) : undefined,
  }));
  for (const [overrides, expected] of cases) {
    assert.throws(() => planReleaseManifest(hashed, fixture.target, withX64(overrides)), expected);
  }
  assert.ok(planReleaseManifest(hashed, fixture.target, records(fixture)));
});


test("renders a host feed listing every arch with the first as path", () => {
  const feed = renderHostFeed({
    version,
    releaseDate: new Date("2026-09-10T12:00:00.000Z"),
    files: [
      { url: "omp-ui-host-1.2.3-mac-x64.zip", arch: "x64", size: 2, sha512: "x64hash" },
      { url: "omp-ui-host-1.2.3-mac-arm64.zip", arch: "arm64", size: 1, sha512: "arm64hash" },
    ],
  });
  assert.equal(
    feed,
    [
      "version: 1.2.3",
      "files:",
      "  - url: omp-ui-host-1.2.3-mac-arm64.zip",
      "    sha512: arm64hash",
      "    size: 1",
      "    arch: arm64",
      "  - url: omp-ui-host-1.2.3-mac-x64.zip",
      "    sha512: x64hash",
      "    size: 2",
      "    arch: x64",
      "path: omp-ui-host-1.2.3-mac-arm64.zip",
      "sha512: arm64hash",
      "releaseDate: '2026-09-10T12:00:00.000Z'",
      "",
    ].join("\n"),
  );
  assert.throws(() => renderHostFeed({ version, files: [] }), /at least one archive/);
});

async function writeFixture(t, fixture, recordList = records(fixture)) {
  const root = await mkdtemp(path.join(tmpdir(), "release-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "dist");
  const outDir = path.join(root, "manifest");
  const recordsDir = path.join(root, "records");
  await mkdir(dir);
  await mkdir(recordsDir);
  await Promise.all([
    ...fixture.names.map((name) => writeFile(path.join(dir, name), fixtureBytes(fixture, name))),
    ...recordList.map(({ name, record }) => writeFile(path.join(recordsDir, name), JSON.stringify(record))),
  ]);
  return { dir, outDir, recordsDir };
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
    "--records",
    paths.recordsDir,
  ]);
}

for (const [platform, fixture] of Object.entries(fixtures)) {
  test(`CLI plans real ${platform} files, hashes host archives, and writes checksum inputs`, async (t) => {
    const paths = await writeFixture(t, fixture);
    const { stdout } = await runCli(fixture, paths);
    const plan = JSON.parse(stdout);
    const distributables = sorted(fixture.names.filter((name) => !name.endsWith(".yml")));

    assert.deepEqual(plan.checksumInputs, distributables);
    assert.equal(
      await readFile(path.join(paths.outDir, "checksum-inputs.txt"), "utf8"),
      `${distributables.join("\n")}\n`,
    );
    for (const artifact of plan.artifacts) {
      if (artifact.kind === "host") {
        assert.equal(artifact.sha256, sha256Of(fixtureBytes(fixture, artifact.name)));
      } else {
        assert.equal(artifact.sha256, undefined);
      }
    }

    if (platform === "mac") {
      const latestMac = await readFile(path.join(paths.outDir, "latest-mac.yml"), "utf8");
      const primary = fixture.names[0];
      const primaryHash = createHash("sha512").update(Buffer.alloc(1, 0)).digest("base64");
      assert.match(latestMac, /^version: 1\.2\.3\nfiles:\n/);
      for (const name of fixture.names.slice(0, 4)) assert.match(latestMac, new RegExp(`  - url: ${name}`));
      assert.ok(latestMac.includes(`path: ${primary}\nsha512: ${primaryHash}`));
      assert.match(latestMac, /releaseDate: '\d{4}-\d\d-\d\dT[^']+'\n$/);
    } else {
      await assert.rejects(readFile(path.join(paths.outDir, "latest-mac.yml")), /ENOENT/);
    }
  });
}

test("CLI rejects a record whose SHA-256 differs from the downloaded archive", async (t) => {
  const fixture = fixtures.win;
  const tampered = records(fixture).map((entry) =>
    entry.record.arch === "x64"
      ? { ...entry, record: { ...entry.record, artifact: { ...entry.record.artifact, sha256: "d".repeat(64) } } }
      : entry,
  );
  const paths = await writeFixture(t, fixture, tampered);
  await assert.rejects(runCli(fixture, paths), /SHA-256 d{64} does not match the release asset/);
});

test("CLI rejects missing and duplicate artifacts", async (t) => {
  for (const extraName of [null, "omp-ui_1.2.3_x64.AppImage"]) {
    const fixture = {
      ...fixtures.linux,
      names: extraName
        ? [...fixtures.linux.names, extraName]
        : fixtures.linux.names.filter((name) => !name.endsWith("armv7l.AppImage")),
    };
    const paths = await writeFixture(t, fixture, records(fixtures.linux));
    await assert.rejects(
      runCli(fixture, paths),
      extraName ? /Duplicate linux appimage artifact for x64/ : /Missing linux artifacts: armv7l appimage/,
    );
  }
});

test("host-feed CLI composes one feed from every archive of a platform in a directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "host-feed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const arm64 = Buffer.from("arm64 archive");
  const x64 = Buffer.from("x64 archive bytes");
  await writeFile(path.join(root, "omp-ui-host-1.2.3-mac-arm64.zip"), arm64);
  await writeFile(path.join(root, "omp-ui-host-1.2.3-mac-x64.zip"), x64);
  await writeFile(path.join(root, "omp-ui-host-1.2.3-win-x64.zip"), Buffer.from("foreign"));
  await writeFile(path.join(root, "omp-ui-1.2.3-mac-preview-x64.zip"), Buffer.from("desktop"));
  const out = path.join(root, "latest-host-mac.yml");

  await execFileAsync(process.execPath, [feedScript, "--dir", root, "--platform", "mac", "--version", version, "--out", out]);

  const feed = await readFile(out, "utf8");
  const sha512 = (bytes) => createHash("sha512").update(bytes).digest("base64");
  assert.ok(feed.startsWith("version: 1.2.3\nfiles:\n  - url: omp-ui-host-1.2.3-mac-arm64.zip\n"));
  assert.ok(feed.includes(`    sha512: ${sha512(arm64)}\n    size: ${arm64.length}\n    arch: arm64\n`));
  assert.ok(feed.includes(`  - url: omp-ui-host-1.2.3-mac-x64.zip\n    sha512: ${sha512(x64)}\n    size: ${x64.length}\n    arch: x64\n`));
  assert.ok(!feed.includes("win-x64"));
  assert.ok(!feed.includes("mac-preview"));
  assert.ok(feed.includes(`path: omp-ui-host-1.2.3-mac-arm64.zip\nsha512: ${sha512(arm64)}\n`));
  await assert.rejects(
    execFileAsync(process.execPath, [feedScript, "--dir", root, "--platform", "linux", "--version", version, "--out", out]),
    /No omp-ui-host-1.2.3-linux-\* archive/,
  );
});
