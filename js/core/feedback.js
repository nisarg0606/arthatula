/* Feedback to the maintainer: a prefilled GitHub new-issue link for
   nisarg0606/arthatula. Shared by the app's Send feedback links and the
   MCP send_feedback tool. Each copy runs on its owner's own Cloudflare
   account, so nothing is filed from here: the person (or their agent)
   opens the link and submits it, publicly, on GitHub.

   The templates are issue forms (.github/ISSUE_TEMPLATE), which ignore
   a body= parameter; their fields prefill by id instead. Every form has
   a "context" field; the main text goes to the field named here. */

export const FEEDBACK_REPO = "nisarg0606/arthatula";
export const FEEDBACK_KINDS = {
  bug: { template: "bug_report.yml", field: "what-happened" },
  feature: { template: "feature_request.yml", field: "problem" },
  feedback: { template: "feedback.yml", field: "details" }
};
export const TITLE_MAX = 120;
export const DETAILS_MAX = 4000;

/* Blank out things that look like they could carry data nobody meant to
   share: emails, dollar amounts, long digit runs (card / account
   numbers) and long token-like strings. */
export function scrub(text) {
  return String(text)
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/\$\s?\d[\d,]*(\.\d+)?/g, "[amount]")
    .replace(/\b\d[\d -]{6,}\d\b/g, "[number]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[token]");
}

/* The new-issue URL for one kind, with the main text and context
   prefilled. Throws on an unknown kind. */
export function feedbackUrl(kind, title, details, context) {
  const k = FEEDBACK_KINDS[kind];
  if (!k) throw new Error("kind must be one of: " + Object.keys(FEEDBACK_KINDS).join(", "));
  const q = new URLSearchParams({ template: k.template });
  if (title) q.set("title", title);
  if (details) q.set(k.field, details);
  if (context) q.set("context", context);
  return "https://github.com/" + FEEDBACK_REPO + "/issues/new?" + q.toString();
}
