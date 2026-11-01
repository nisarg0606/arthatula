/*
 * Auto-review (serves /api/v2/autoreview). The app calls this when it
 * opens; see ../_v2autoreview.js for how each waiting bank row is judged.
 *   POST -> { reviewed, duplicates, asked, remaining, by: "gemini"|"rules"|null }
 *        Looks at up to 30 rows per call that haven't been looked at
 *        yet; call again while remaining > 0.
 */
import { handleV2 } from "../_v2http.js";
import { runAutoReview } from "../_v2autoreview.js";

export const onRequestPost = (context) => handleV2(context, ({ s, env }) => runAutoReview(s, env));
