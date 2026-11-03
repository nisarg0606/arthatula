/* RFC 8414 Authorization Server Metadata — see the note in
   oauth-protected-resource.js about _middleware.js interception. */
import { authorizationServerMetadata } from "../api/_oauth.js";
export const onRequestGet = (context) => authorizationServerMetadata(context.request);
