import { describe, expect, it } from "vitest";
import { boundOutput, OUTPUT_LIMIT, redact } from "../src/redact.ts";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("redact", () => {
  it("replaces every occurrence of each secret", () => {
    const key = "sk-ant-abcdefgh12345";
    expect(redact(`key=${key}\nagain ${key}, token tok-98765432`, [key, "tok-98765432"])).toBe(
      "key=[redacted]\nagain [redacted], token [redacted]",
    );
  });

  it("does not replace secrets shorter than 8 characters", () => {
    expect(redact("pin 1234567 and 12345678", ["1234567", "12345678"])).toBe("pin 1234567 and [redacted]");
  });

  it("leaves text without secrets as it is", () => {
    expect(redact("all clear", [])).toBe("all clear");
  });
});

describe("boundOutput", () => {
  it("Scenario: Long output is cut", () => {
    const lines = Array.from({ length: 21_000 }, (_, index) => `line ${String(index).padStart(5, "0")} ${"x".repeat(40)}`);
    lines.push("the check's last line");
    const output = lines.join("\n") + "\n";
    expect(bytes(output)).toBeGreaterThan(1024 * 1024);

    const cut = boundOutput(output);
    expect(OUTPUT_LIMIT).toBe(16 * 1024);
    expect(bytes(cut)).toBeLessThanOrEqual(16 * 1024);
    expect(cut.endsWith("the check's last line\n")).toBe(true);
    // Cut at a line start: the first line kept is a whole line of the output.
    expect(lines).toContain(cut.split("\n")[0]);
    expect(bytes(cut)).toBeGreaterThan(15 * 1024);
  });

  it("keeps short output whole", () => {
    expect(boundOutput("one\ntwo\n")).toBe("one\ntwo\n");
  });

  it("counts bytes, not characters", () => {
    const cut = boundOutput(("€".repeat(100) + "\n").repeat(100), 1000);
    expect(bytes(cut)).toBeLessThanOrEqual(1000);
    expect(cut).toMatch(/^€+\n/);
  });

  it("keeps the end of a single line longer than the limit", () => {
    const cut = boundOutput("€".repeat(1000), 100);
    expect(bytes(cut)).toBeLessThanOrEqual(100);
    expect(cut).toMatch(/^€+$/);
  });
});
