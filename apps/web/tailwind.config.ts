import type { Config } from "tailwindcss";

/**
 * unuMCP visual language — an editorial workbench, not a SaaS template.
 *  - warm paper surface + near-black ink, hairline borders instead of big shadows
 *  - one warm accent (clay/terracotta) for "your turn" moments; status colors
 *    are reserved strictly for pipeline state (pass/fail/warn/run)
 *  - serif for display headings, mono for the technical ledger (methods, ids, counts)
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#FAF8F3",
        panel: "#FFFFFF",
        ink: {
          DEFAULT: "#1B1A16",
          soft: "#3C3A33",
          muted: "#6E6A5F",
          faint: "#9B968A",
        },
        line: {
          DEFAULT: "#E8E3D7",
          strong: "#D9D2C2",
        },
        clay: {
          DEFAULT: "#B0512B",
          soft: "#C16A45",
          wash: "#F5EAE1",
        },
        ok: { DEFAULT: "#2E7850", wash: "#E7F1EA" },
        warn: { DEFAULT: "#946610", wash: "#F6EDD7" },
        bad: { DEFAULT: "#AE3A33", wash: "#F6E6E4" },
        run: { DEFAULT: "#2B5C97", wash: "#E6ECF5" },
      },
      fontFamily: {
        serif: ["Fraunces", "Iowan Old Style", "Georgia", "Cambria", "serif"],
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        sm: "3px",
        DEFAULT: "5px",
        md: "7px",
        lg: "10px",
        xl: "14px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(27, 26, 22, 0.04), 0 1px 1px rgba(27, 26, 22, 0.03)",
        lift: "0 6px 24px -10px rgba(27, 26, 22, 0.20)",
        ring: "0 0 0 3px rgba(176, 81, 43, 0.18)",
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.02em" }],
      },
      letterSpacing: {
        eyebrow: "0.14em",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.32s cubic-bezier(0.22, 1, 0.36, 1)",
        "pulse-soft": "pulse-soft 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
