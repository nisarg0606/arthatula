/* Apply the remembered / device theme before first paint. Loaded as a
   blocking <script src> in <head> (not inline) so the Content-Security-
   Policy can stay script-src 'self'. */
(function () {
  try {
    var t = localStorage.getItem("arthatula-theme");
    if (t === "dark" || (!t && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
      document.documentElement.classList.add("dark");
    }
    if (localStorage.getItem("arthatula-hide-amounts") === "1") document.documentElement.classList.add("hide-amounts");
  } catch (e) {}
})();
