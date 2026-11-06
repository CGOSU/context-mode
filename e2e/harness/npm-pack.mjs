// npm 11 returns an array; npm 12 keys the same reports by package name.
// Keep the single-package and file-manifest checks before consuming either form.
export function npmPackInfo(stdout) {
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed) ? parsed
    : parsed !== null && typeof parsed === "object" ? Object.values(parsed) : [];
  const info = entries[0];
  if (entries.length !== 1 || !Array.isArray(info?.files) || typeof info.filename !== "string") {
    throw new Error("npm pack returned no single package file manifest");
  }
  return info;
}
