import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmounts what each test rendered, since Vitest runs without globals.
afterEach(() => {
  cleanup();
});
