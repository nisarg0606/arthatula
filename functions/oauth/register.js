/* OAuth 2.1 Dynamic Client Registration — logic in ../api/_oauth.js. */
import { registerClient } from "../api/_oauth.js";
export const onRequestPost = registerClient;
