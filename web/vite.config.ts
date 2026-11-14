import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Configure Vite to serve the React browser application and its worker modules.
export default defineConfig({
  plugins: [react()],
});
