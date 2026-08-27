import { readFileSync } from "node:fs";

const suite = JSON.parse(readFileSync(new URL("../cases.json", import.meta.url), "utf8"));
const byId = new Map(suite.cases.map((item) => [item.id, item]));

/**
 * Harness-only fixture. It mirrors the canonical required labels to exercise
 * schema and scoring plumbing; its pass rate is never behavior evidence.
 */
export async function run({ caseId, locale, mode, turns }) {
  const item = byId.get(caseId);
  if (!item || !item.variants.some((variant) => variant.locale === locale)) {
    throw new Error("fake adapter received an unknown case or locale");
  }
  if (!['baseline', 'skill'].includes(mode) || !Array.isArray(turns)) {
    throw new Error("fake adapter received an invalid harness request");
  }
  return {
    response: "Synthetic harness-only response; not model behavior evidence.",
    events: ["harness.fake_adapter_fixture"],
    actions: [...item.assertions.required_decisions],
  };
}
