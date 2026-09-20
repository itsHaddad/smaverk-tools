// The planner decides how much of each recording gets transcribed, so a mistake here does not fail —
// it quietly returns a transcript that is missing the end of the show. These tests exist for that.

import { expect, test, describe } from "bun:test";
import { $ } from "bun";

const plan = async (args: string) => {
  const out = await $`bun bench/asr/plan.ts ${{ raw: args }}`.quiet().nothrow();
  const line = out.stdout.toString().trim();
  return {
    ok: out.exitCode === 0,
    stderr: out.stderr.toString(),
    jobs: line.startsWith("matrix=") ? (JSON.parse(line.slice("matrix=".length)).include as { ref: string; from: number; to: number }[]) : [],
  };
};

describe("plan", () => {
  test("covers a long recording end to end when given its length", async () => {
    const { jobs } = await plan("--refs XyZ:226 --model tiny --slice-minutes 30 --budget-minutes 999");
    expect(jobs.length).toBe(8);
    expect(jobs[0]!.from).toBe(0);
    expect(jobs[jobs.length - 1]!.to).toBe(226 * 60);
    // No gaps: each shard starts where the last ended.
    for (let i = 1; i < jobs.length; i++) expect(jobs[i]!.from).toBe(jobs[i - 1]!.to);
  });

  test("falls back to an assumed length for a bare id", async () => {
    const { jobs } = await plan("--refs abc --model tiny --slice-minutes 30 --budget-minutes 999");
    expect(jobs.every((j) => j.ref === "abc")).toBe(true);
    expect(jobs[jobs.length - 1]!.to).toBe(3600);
  });

  test("refuses a run that would cost more than its budget, rather than trimming it", async () => {
    const r = await plan("--refs a:300,b:300 --model small --slice-minutes 30 --budget-minutes 60");
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/budget of 60/);
    expect(r.jobs).toHaveLength(0);
  });

  test("rejects an unknown model and a nonsense length instead of guessing", async () => {
    expect((await plan("--refs a --model enormous --budget-minutes 999")).ok).toBe(false);
    expect((await plan("--refs a:0 --model tiny --budget-minutes 999")).ok).toBe(false);
  });

  test("needs at least one reference", async () => {
    expect((await plan("--model tiny --budget-minutes 999")).ok).toBe(false);
  });
});
