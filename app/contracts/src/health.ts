import { z } from "zod";

/**
 * The body of `GET /health` (change add-app-foundations). The 503 response carries the same
 * shape, with `database: "unavailable"`. `commit` is the commit the API was synthesised from.
 */
export const HealthResponse = z.strictObject({
  status: z.literal("ok"),
  database: z.enum(["ok", "unavailable"]),
  commit: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
