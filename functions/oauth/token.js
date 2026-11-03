/* OAuth 2.1 token endpoint — logic lives in ../api/_oauth.js. */
import { tokenPost } from "../api/_oauth.js";
export const onRequestPost = tokenPost;
