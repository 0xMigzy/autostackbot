// "Approve in Tangem" buttons open AutoStack's /open page on GitHub Pages, which redirects to the Tangem app
// (Telegram buttons only accept http(s) links). The allow-list lives in one file, shared with that page.
import { approvePageUrl } from "../demo-miniapp/public/open/link.js";

export const APPROVE_PAGE = "https://0xmigzy.github.io/autostackbot/open/";

/** https link that opens this buy in Tangem, or null when the deeplink isn't a valid Tangem buy link. */
export const approveUrl = (deeplink) => approvePageUrl(deeplink, APPROVE_PAGE);
