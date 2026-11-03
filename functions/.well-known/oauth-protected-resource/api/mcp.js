/* RFC 9728 path-suffixed Protected Resource Metadata for /api/mcp. */
import { protectedResourceMetadata } from "../../../api/_oauth.js";
export const onRequestGet = (context) => protectedResourceMetadata(context.request);
