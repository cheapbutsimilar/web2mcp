import { describe, expect, it } from "vitest";
import { runSelfTest } from "../src/selftest.js";

describe("end-to-end: record → generate → build → call via MCP", () => {
  it("passes every self-test step against the local mock shop", async () => {
    const res = await runSelfTest();
    const failed = res.steps.filter((s) => !s.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.steps.length).toBeGreaterThanOrEqual(9);
  });
});
