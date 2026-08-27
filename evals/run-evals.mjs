#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  LOCALES,
  MODES,
  assertOutputDistinctFromInputs,
  loadSuite,
  parseFlags,
  resolveOutputPath,
  score,
  snapshotAdapterResult,
  suitePath,
  validateAdapterLabel,
  writeJsonlAtomic,
} from "./lib.mjs";

const specification = {
  "--adapter": { name: "adapter" },
  "--mode": { name: "mode" },
  "--repetitions": { name: "repetitions" },
  "--out": { name: "out" },
  "--case": { name: "cases", repeatable: true },
  "--locale": { name: "locales", repeatable: true },
  "--allow-persistent-output": { name: "allowPersistent", boolean: true },
};

async function main() {
  const options = parseFlags(process.argv.slice(2), specification);
  if (!options.adapter) throw new Error("--adapter is required");
  if (!MODES.includes(options.mode)) throw new Error("--mode must be baseline or skill");
  if (!/^[1-9]\d*$/u.test(options.repetitions ?? "")) throw new Error("--repetitions must be an integer >= 1");
  const repetitions = Number(options.repetitions);
  if (!Number.isSafeInteger(repetitions)) throw new Error("--repetitions is too large");

  const adapterPath = path.resolve(process.cwd(), options.adapter);
  const adapterName = validateAdapterLabel(path.basename(adapterPath));

  const suite = loadSuite();
  const knownCases = new Set(suite.cases.map(({ id }) => id));
  for (const caseId of options.cases ?? []) {
    if (!knownCases.has(caseId)) throw new Error(`unknown case: ${caseId}`);
  }
  for (const locale of options.locales ?? []) {
    if (!LOCALES.includes(locale)) throw new Error(`unknown locale: ${locale}`);
  }

  const output = resolveOutputPath(options.out, { allowPersistent: options.allowPersistent === true });
  const protectedInputs = [
    { path: suitePath, label: "canonical suite" },
    { path: adapterPath, label: "adapter module" },
  ];
  assertOutputDistinctFromInputs(output, protectedInputs);
  const adapter = await import(pathToFileURL(adapterPath).href);
  if (typeof adapter.run !== "function") throw new Error("adapter must export a named run function");
  const caseFilter = new Set(options.cases ?? suite.cases.map(({ id }) => id));
  const localeFilter = new Set(options.locales ?? LOCALES);
  const records = [];

  for (const item of suite.cases) {
    if (!caseFilter.has(item.id)) continue;
    for (const variant of item.variants) {
      if (!localeFilter.has(variant.locale)) continue;
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const attemptId = `${item.id}/${variant.locale}/${options.mode}/${repetition}`;
        const startedAt = new Date().toISOString();
        const result = await adapter.run({
          caseId: item.id,
          locale: variant.locale,
          mode: options.mode,
          turns: variant.turns.map(({ role, content }) => ({ role, content })),
        });
        const endedAt = new Date().toISOString();
        const observed = snapshotAdapterResult(result);
        const scoring = score(item, observed.actions);
        const record = {
          attemptId,
          caseId: item.id,
          locale: variant.locale,
          mode: options.mode,
          repetition,
          response: observed.response,
          events: observed.events,
          ...(observed.actions === undefined ? {} : { actions: observed.actions }),
          ...scoring,
          startedAt,
          endedAt,
          adapter: adapterName,
        };
        records.push(record);
      }
    }
  }
  assertOutputDistinctFromInputs(output, protectedInputs);
  writeJsonlAtomic(output, records);
  process.stdout.write(`${records.length} attempts written\n`);
}

main().catch((error) => {
  process.stderr.write(`eval runner: ${error.message}\n`);
  process.exitCode = 1;
});
