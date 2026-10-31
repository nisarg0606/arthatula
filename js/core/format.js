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

export function fmt(n) {
  var sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
