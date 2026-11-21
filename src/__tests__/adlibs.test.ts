import { describe, expect, it } from "vitest";
import { adlibMask, adlibSegments } from "../lib";

describe("adlibSegments", () => {
  it("splits a parenthesized group out of the lead text", () => {
    expect(adlibSegments("I need you (yeah, yeah) tonight")).toEqual([
      { text: "I need you ", adlib: false },
      { text: "(yeah, yeah)", adlib: true },
      { text: " tonight", adlib: false },
    ]);
  });

  it("flags a trailing adlib", () => {
    const parts = adlibSegments("run it back (run it back)");
    expect(parts[0].adlib).toBe(false);
    expect(parts[1]).toEqual({ text: "(run it back)", adlib: true });
  });

  it("handles several groups in one line", () => {
    const parts = adlibSegments("uh (uh) lights (on) now");
    expect(parts.map((p) => p.adlib)).toEqual([false, true, false, true, false]);
  });

  it("returns a plain token when there are no adlibs", () => {
    expect(adlibSegments("just a line")).toEqual([{ text: "just a line", adlib: false }]);
  });
});

describe("adlibMask", () => {
  it("flags every word inside a paren group", () => {
    expect(adlibMask(["I", "need", "(yeah,", "yeah)", "tonight"])).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
  });

  it("flags single-word parenthesized adlibs", () => {
    expect(adlibMask(["go", "(go)", "go"])).toEqual([false, true, false]);
  });

  it("keeps the group open across unbalanced text", () => {
    expect(adlibMask(["sing", "(ooh", "ooh"])).toEqual([false, true, true]);
  });
});
