import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";

const API = "https://api.example.invalid";

function renderApp(): void {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
}

function stubFetch(answer: () => Promise<Response>) {
  const fetch = vi.fn<typeof globalThis.fetch>(answer);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const json = (body: unknown, status: number) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", API);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("App", () => {
  it("Scenario: Shows checking first", () => {
    stubFetch(() => new Promise<Response>(() => undefined));
    renderApp();
    expect(screen.getByRole("heading", { name: "Kindle Vocab" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("checking");
  });

  it("Scenario: Shows ok for a healthy response", async () => {
    const fetch = stubFetch(() => json({ status: "ok", database: "ok", commit: "abc123" }, 200));
    renderApp();
    expect(await screen.findByText("ok")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(`${API}/health`, expect.anything());
  });

  it("Scenario: Shows unavailable for a 503", async () => {
    stubFetch(() => json({ status: "ok", database: "unavailable", commit: "abc123" }, 503));
    renderApp();
    expect(await screen.findByText("unavailable")).toBeInTheDocument();
  });

  it("Scenario: Shows unavailable for a network error", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    renderApp();
    expect(await screen.findByText("unavailable")).toBeInTheDocument();
  });

  it("Scenario: Shows unavailable for a response that fails HealthResponse", async () => {
    stubFetch(() => json({ status: "ok", database: "maybe" }, 200));
    renderApp();
    expect(await screen.findByText("unavailable")).toBeInTheDocument();
  });
});
