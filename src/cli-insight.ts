/** CLI insight implementation; importing this module never dispatches commands. */


import { openInBrowser } from "./cli-shared.js";


/* -------------------------------------------------------
 * Insight — hosted analytics dashboard
 * ------------------------------------------------------- */

// Insight pivoted from a locally-built dashboard to the hosted product at
// context-mode.com/insight (the landing page is the single source of truth).
// The command now just opens that URL in the default browser.
async function insight() {
  const url = "https://context-mode.com/insight";
  console.log(`\n  context-mode Insight\n  ${url}\n`);
  // Open browser — execFile with arg array, no shell interpolation.
  openInBrowser(url);
}

export { insight };
