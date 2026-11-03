/* OAuth 2.1 authorization endpoint — logic lives in ../api/_oauth.js. */
import { authorizeGet, authorizePost } from "../api/_oauth.js";
export const onRequestGet = authorizeGet;
export const onRequestPost = authorizePost;
