import { HealthResponse } from "@vocab/contracts";

// The web app's API client (change add-app-foundations). The API's URL is set at build
// time: `infra:synth` builds each environment with its own `VITE_API_URL`.

export type HealthState = "checking" | HealthResponse["database"];

/**
 * Asks `GET /health` whether the API reaches its database. Anything but a valid
 * `HealthResponse` with `database: "ok"`, including a network error, is "unavailable".
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse["database"]> {
  try {
    const response = await fetch(`${import.meta.env.VITE_API_URL}/health`, {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    const body = HealthResponse.safeParse(await response.json());
    return response.ok && body.success ? body.data.database : "unavailable";
  } catch {
    return "unavailable";
  }
}
