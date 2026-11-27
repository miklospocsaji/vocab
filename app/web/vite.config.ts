import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web app's build (change add-app-foundations): `vite build` writes `dist/`, which the
// app stack deploys to its bucket. `VITE_API_URL` comes from the environment at build time.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
