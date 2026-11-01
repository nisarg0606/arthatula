/* Tailwind build config. The page loads the prebuilt tailwind.css;
   after changing classes in index.html or js/, rebuild it with:
     npx -y tailwindcss@3.4.17 -c tailwind.config.js -o tailwind.css --minify
   (CI fails when tailwind.css is out of date.) */
module.exports = {
  content: ["./index.html", "./js/**/*.js"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: { sans: ["-apple-system", "BlinkMacSystemFont", "system-ui", "Segoe UI", "Roboto", "sans-serif"] },
      colors: {
        ink: "#0f172a", muted: "#475569",
        darkbg: "#0f172a", darkcard: "#1e293b", darkink: "#f1f5f9", darkmuted: "#cbd5e1"
      },
      boxShadow: { soft: "0 10px 30px rgba(2,6,23,.10)" }
    }
  }
};
