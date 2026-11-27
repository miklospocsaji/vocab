import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { base } from "../config.ts";
import { buildStacks } from "../src/stacks.ts";

// The CDK app (ADR 0006). `infra:synth` runs it through `cdk synth` with
// `-c env=base|test|prod -c commit=<sha>`; it builds only that environment's stacks and
// makes no AWS calls.

const app = new App();
const env = app.node.tryGetContext("env") as unknown;
const commit = app.node.tryGetContext("commit") as unknown;
if (typeof env !== "string") throw new Error("Missing context: -c env=base|test|prod");
if (typeof commit !== "string" || commit === "") throw new Error("Missing context: -c commit=<sha>");

buildStacks(app, env, {
  base,
  commit,
  webDist: resolve(import.meta.dirname, "../../app/web/dist"),
  note: (message) => {
    console.error(`Note: ${message}`);
  },
});
app.synth();
