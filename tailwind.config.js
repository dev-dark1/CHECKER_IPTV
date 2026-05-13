/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        night: "#050816",
        surface: "#091224",
        panel: "#0f1b33",
        glass: "rgba(10, 22, 43, 0.62)",
        neon: {
          blue: "#4CF2FF",
          cyan: "#12D9FF",
          green: "#39FF88",
          red: "#FF5A78",
          amber: "#FFC857"
        }
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(76, 242, 255, 0.2), 0 22px 80px rgba(9, 19, 36, 0.65)",
        neon: "0 0 24px rgba(18, 217, 255, 0.18)",
        success: "0 0 26px rgba(57, 255, 136, 0.28)"
      },
      animation: {
        float: "float 7s ease-in-out infinite",
        pulseSoft: "pulseSoft 1.8s ease-in-out infinite",
        scan: "scan 2.8s linear infinite",
        blink: "blink 1.1s step-end infinite"
      },
      backdropBlur: {
        xl: "24px"
      },
      keyframes: {
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-10px)" }
        },
        pulseSoft: {
          "0%, 100%": { opacity: "0.55", transform: "scale(1)" },
          "50%": { opacity: "1", transform: "scale(1.02)" }
        },
        scan: {
          "0%": { transform: "translateX(-120%)" },
          "100%": { transform: "translateX(120%)" }
        },
        blink: {
          "50%": { opacity: "0" }
        }
      }
    }
  },
  plugins: []
};
