#!/usr/bin/env node
import { createInterface } from "node:readline/promises";

import {
  adjudicateAttempts,
  renderUntrustedResponse,
  validateAttempts,
} from "./adjudication-core.mjs";
import {
  assertOutputDistinctFromInputs,
  loadSuite,
  parseFlags,
  parseJsonl,
  revalidateOutputForWrite,
  resolveInputPath,
  resolveOutputPath,
  suitePath,
  writeJsonlAtomic,
} from "./lib.mjs";

const specification = {
  "--input": { name: "input" },
  "--out": { name: "out" },
};

async function main() {
  const options = parseFlags(process.argv.slice(2), specification);
  const input = resolveInputPath(options.input);
  const output = resolveOutputPath(options.out);
  const protectedInputs = [
    { path: suitePath, label: "canonical suite" },
    { path: input, label: "raw eval" },
  ];
  assertOutputDistinctFromInputs(output, protectedInputs);

  const suite = loadSuite();
  const attempts = parseJsonl(input);
  validateAttempts(attempts, suite);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("interactive adjudication requires a TTY and has no non-interactive CLI bypass");
  }

  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let records;
  try {
    records = await adjudicateAttempts({
      attempts,
      suite,
      reviewer: "manual",
      selectActions: async ({ attempt, allowedActions }) => {
        process.stdout.write(`\nAttempt ${attempt.attemptId}\n${renderUntrustedResponse(attempt.response)}\nAllowed action labels:\n`);
        allowedActions.forEach((label, index) => process.stdout.write(`  ${index + 1}. ${label}\n`));
        const answer = await terminal.question("Select comma-separated numbers (blank for none): ");
        return answer.trim() === "" ? [] : answer.split(",").map((part) => {
          const index = Number(part.trim());
          if (!Number.isInteger(index) || index < 1 || index > allowedActions.length) {
            throw new Error("selection must use displayed label numbers only");
          }
          return allowedActions[index - 1];
        });
      },
    });
  } finally {
    terminal.close();
  }

  const finalOutput = revalidateOutputForWrite(output, { allowPersistent: false, inputs: protectedInputs });
  writeJsonlAtomic(finalOutput, records);
  process.stdout.write(`${records.length} attempts adjudicated\n`);
}

main().catch((error) => {
  process.stderr.write(`eval adjudicator: ${error.message}\n`);
  process.exitCode = 1;
});
