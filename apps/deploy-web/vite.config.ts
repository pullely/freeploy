import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// deploy-web: the exact UI port of Coolify (freeploy-coolify-parity DP3).
// CSS goes through PostCSS with @tailwindcss/postcss, as Coolify's own build does.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", assetsDir: "build", sourcemap: false },
});
