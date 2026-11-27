// /open: sends the visitor straight to the Tangem app for one buy approval. No tracking, no other network calls.
import { tangemLinkFromQuery } from "./link.js";

const link = tangemLinkFromQuery(window.location.search);
const status = document.getElementById("status");
const button = document.getElementById("open");
const hint = document.getElementById("hint");

if (link) {
  button.href = link;
  button.hidden = false;
  hint.hidden = false;
  window.location.href = link;
} else {
  status.textContent = "This approval link isn't valid.";
  hint.textContent = "Open the Tangem app, or tap the Tangem notification on your phone.";
  hint.hidden = false;
}
