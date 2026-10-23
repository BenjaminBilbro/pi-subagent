process.stderr.write(`STRATA_PREFIX=${process.env.PI_SUBAGENT_STRATA_PREFIX}\n`);
await import("./fake-pi-success.mjs");
