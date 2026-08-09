export function appUpdateEnabledForBuild(opts: {
  packaged: boolean;
  platform: NodeJS.Platform;
  forceEnabled: boolean;
}): boolean {
  return opts.forceEnabled || (opts.packaged && (opts.platform === "linux" || opts.platform === "win32"));
}
