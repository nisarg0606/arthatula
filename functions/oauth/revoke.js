/* OAuth 2.1 token revocation (RFC 7009) — logic in ../api/_oauth.js. */
import { revokePost } from "../api/_oauth.js";
export const onRequestPost = revokePost;
