/**
 * The factory's CDK app (add-cloud-proposal-run design). The account comes from the deploy
 * credentials; the region is always eu-central-1 (brief, section 5). Non-secret settings live
 * in cdk.json's context. The budget alarm's address is passed at deploy and never committed:
 *   pnpm infra:deploy -c budgetEmail=<address>
 */
import { App } from "aws-cdk-lib";
import { FactoryStack, factoryContext } from "../factory-stack.ts";

const app = new App();
const account = process.env["CDK_DEFAULT_ACCOUNT"];
new FactoryStack(app, "Factory", {
  env: { ...(account === undefined ? {} : { account }), region: "eu-central-1" },
  ...factoryContext(app),
});
