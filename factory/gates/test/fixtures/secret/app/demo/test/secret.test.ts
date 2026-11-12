import { expect, it } from "vitest";

const apiKey = "sk-ant-fixture-0123456789abcdef";

it("prints the API key", () => {
  console.log(`the key is ${apiKey}`);
  expect(apiKey).toBe("something else");
});
