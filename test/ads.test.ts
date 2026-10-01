/**
 * The three rewarded slots, and the gate that keeps them off on this platform.
 *
 * The SDK has no ad API, so `ADS_ENABLED` is false in every build and none of
 * the slots — +5 moves, a draft reroll, double petals — is offered at all. The
 * gate lives in the client, not the sim (a pure state operation is the wrong
 * place for a platform rule), so this file reads the client and pins it there.
 * That is a blunt instrument, and it is the only thing standing between a
 * build that quietly turned ads on and a player shown a button that answers
 * "no reward this time".
 *
 * The analytics that used to ride alongside the slots is pinned as gone, too:
 * this platform has no events API, and the port deleted the transport rather
 * than stubbing it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const client = read("../src/game/client.ts");
const host = read("../src/platform/host.ts");
const build = read("../scripts/build.mjs");

describe("the ads gate", () => {
  it("is the build flag, off unless ADS=1", () => {
    expect(build).toContain('ADS_ENABLED: JSON.stringify(process.env.ADS === "1")');
    expect(host).toContain("adsEnabled: ADS_ENABLED");
  });

  it("refuses at the host while the platform has no ad API", () => {
    expect(host).toContain("requestRewardedAd: async () => false");
  });

  it("is what every slot asks before it is offered", () => {
    expect(client).toContain("return this.host.adsEnabled;");
    // The draft reroll — a charm-granted reroll still shows, an ad one does not.
    expect(client).toContain("if (freeRerolls || this.adsAllowed())");
    // Both run-end slots hang off the same `ads` flag.
    expect(client).toContain("const ads = this.adsAllowed();");
    expect(client).toMatch(/const canRevive =\s*ads &&/);
    expect(client).toMatch(/const canDouble = ads &&/);
  });

  it("is checked again on the way to the host, so no slot can ask past it", () => {
    expect(client).toContain("if (!this.adsAllowed()) return false;");
    // Every slot goes through `rewarded`, never straight to the host.
    expect(client.match(/this\.host\.requestRewardedAd\(/g)?.length).toBe(1);
    for (const placement of ["extra_moves", "reroll_draft", "double_petals"]) {
      expect(client).toContain(`await this.rewarded("${placement}")`);
    }
  });
});

describe("what the host hears", () => {
  it("one score, where a move ends the run", () => {
    expect(client.match(/this\.host\.reportScore\(/g)?.length).toBe(1);
    expect(client).toMatch(/this\.awardPetals\(\);\s*this\.reportRunScore\(\);/);
  });

  it("no analytics transport and no cross-promo fetch survive in the client", () => {
    for (const gone of ["track(", "trackAll(", "loadPromos", "fetch(", "telemetry", "window.location"]) {
      expect(client, gone).not.toContain(gone);
    }
  });
});
