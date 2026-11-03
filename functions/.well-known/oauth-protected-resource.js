/* RFC 9728 Protected Resource Metadata for /api/mcp.
   NOTE: dotted function paths are also intercepted by
   functions/_middleware.js, which is the guaranteed Pages route —
   see handleOAuthRequest in ../api/_oauth.js. */
import { protectedResourceMetadata } from "../api/_oauth.js";
export const onRequestGet = (context) => protectedResourceMetadata(context.request);
