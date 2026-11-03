/* OpenID discovery alias: serves the OAuth authorization-server
   metadata (this server issues no ID tokens). */
import { authorizationServerMetadata } from "../api/_oauth.js";
export const onRequestGet = (context) => authorizationServerMetadata(context.request);
