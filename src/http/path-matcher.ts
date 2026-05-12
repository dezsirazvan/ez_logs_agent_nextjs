// Path matcher — port of `path_matches?` in http_request.rb.
//
// Four supported pattern shapes (do not change without bumping wire
// format on both agents in lockstep):
//
//   "*X*"  contains  e.g. "*/login*"     matches "/admin/login/cb"
//   "*X"   suffix    e.g. "*/logout"     matches "/admin/logout"
//   "X*"   prefix    e.g. "/_next/*"     matches "/_next/static/..."
//   "X"    exact     e.g. "/favicon.ico" matches "/favicon.ico" only

export function pathMatches(path: string, pattern: string): boolean {
  const startsWithStar = pattern.startsWith("*");
  const endsWithStar = pattern.endsWith("*");

  if (startsWithStar && endsWithStar) {
    const middle = pattern.slice(1, -1);
    return path.includes(middle);
  }
  if (startsWithStar) {
    const suffix = pattern.slice(1);
    return path.endsWith(suffix);
  }
  if (endsWithStar) {
    const prefix = pattern.slice(0, -1);
    return path.startsWith(prefix);
  }
  return path === pattern;
}

/** Returns true if `path` ends with any of the excluded extensions. */
export function hasExcludedExtension(
  path: string,
  extensions: readonly string[],
): boolean {
  if (!path) return false;
  return extensions.some((ext) => path.endsWith(ext));
}
