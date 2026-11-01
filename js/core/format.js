/* Display formatting: money and device labels. */

/* Human label for a sign-in session, parsed from the user agent:
   "iPhone · Safari", "Android phone · Chrome", "Mac · Chrome", ...
   Sent with setup/login so Settings can list recognizable devices. */

export function deviceLabel(ua) {
  ua = typeof ua === "string" ? ua : (typeof navigator !== "undefined" ? navigator.userAgent : "");
  var device = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android phone"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows PC"
    : /Linux/.test(ua) ? "Linux"
    : "Unknown device";
  var browser = /Edg\//.test(ua) ? "Edge"
    : /CriOS\//.test(ua) || /Chrome\//.test(ua) ? "Chrome"
    : /FxiOS\//.test(ua) || /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  return device + " · " + browser;
}

/* One shared formatter: toLocaleString with options builds a new one per call. */
var MONEY = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* The eye button (header) hides every amount: the formatters print this
   instead while <html> has the hide-amounts class. */
export var HIDDEN = "$•••";
export function amountsHidden() {
  return typeof document !== "undefined" && document.documentElement.classList.contains("hide-amounts");
}

export function fmt(n) {
  if (amountsHidden()) return HIDDEN;
  var sign = n < 0 ? "-" : "";
  return sign + "$" + MONEY.format(Math.abs(n));
}
