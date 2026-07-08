import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: ["class"],
  theme: {
    extend: {
      colors: {
        ink: "#111827",
        paper: "#f6f7f9",
        line: "#d9dee7",
        routemind: {
          teal: "#0f9f91",
          mint: "#d8fff8",
          amber: "#d8952f",
          graphite: "#17202e",
        },
      },
      boxShadow: {
        soft: "0 18px 45px rgba(18, 25, 38, 0.08)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
