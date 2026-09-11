import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export default async function prepareMacosVerifier(context) {
  if (context.electronPlatformName !== "darwin") return;

  const version = context.packager.appInfo.version;
  const verifier = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Resources",
    "host",
    version,
    "resources",
    "plan-verifier",
  );
  const manifestPath = path.join(verifier, "browser.manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const marker = ".app/";
  const appEnd = manifest.executable.indexOf(marker);
  if (appEnd < 0) throw new Error(`Verifier executable is not inside an app bundle: ${manifest.executable}`);
  const browserApp = path.join(verifier, `${manifest.executable.slice(0, appEnd)}.app`);

  await context.packager.sign(
    browserApp,
    context.appOutDir,
    { ...context.packager.platformSpecificBuildOptions, notarize: false, signIgnore: [] },
    context.arch,
  );

  const executable = path.join(verifier, manifest.executable);
  manifest.sha256 = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};
