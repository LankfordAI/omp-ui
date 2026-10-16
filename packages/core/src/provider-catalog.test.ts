import { describe, expect, it } from "vitest";
import { PROVIDER_ENV_NAMES, PROVIDER_KEY_SPECS, providerSpecById } from "./provider-catalog";

describe("PROVIDER_KEY_SPECS", () => {
  it("gives every spec a distinct id", () => {
    const ids = PROVIDER_KEY_SPECS.map((spec) => spec.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it("never lets two specs share an environment variable", () => {
    // PROVIDER_ENV_NAMES is primary-then-alternates across every spec, so a
    // duplicate here means one env name authenticates two rows on the page.
    const dupes = PROVIDER_ENV_NAMES.filter((name, index) => PROVIDER_ENV_NAMES.indexOf(name) !== index);
    expect(dupes).toEqual([]);
  });

  it("resolves each spec by its own id and none by an unknown one", () => {
    for (const spec of PROVIDER_KEY_SPECS) {
      expect(providerSpecById(spec.id)).toBe(spec);
    }
    expect(providerSpecById("sambanova")).toBeUndefined();
  });
});
