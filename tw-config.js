/* Tailwind Play CDN theme config. Must load right after the Tailwind
   script; kept in a file (not inline) for the Content-Security-Policy.
   Guarded so a CDN outage leaves an unstyled-but-working page instead
   of a script error. */
if (window.tailwind) tailwind.config = {
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: { sans: ["Geist", "system-ui", "-apple-system", "Segoe UI", "sans-serif"] },
      colors: {
        ink: "#0f172a", muted: "#475569",
        darkbg: "#0f172a", darkcard: "#1e293b", darkink: "#f1f5f9", darkmuted: "#cbd5e1"
      },
      boxShadow: { soft: "0 10px 30px rgba(2,6,23,.10)" }
    }
  }
};
