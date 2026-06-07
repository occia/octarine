/**
 * Shared formatting for the source identity shown across report surfaces (entry.html header,
 * ledger heading, summary). Keeps the real upstream `branch @ commit` and the synthetic content-id
 * (the cross-run-memory key) consistent everywhere they are displayed.
 */

import { SourceVersion } from "../types";

/** Canonical https web URL for a git remote (github/gitlab ssh + .git forms normalized); "" if not http(s). */
export function repoWebUrl(repoUrl: string): string {
  let u = (repoUrl || "").trim();
  u = u.replace(/^git@([^:]+):/i, "https://$1/"); // ssh → https
  u = u.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) return "";
  return u.replace(/^http:/i, "https:");
}

/** Commit page URL on github/gitlab; "" for other hosts (where the path shape isn't known). */
export function commitWebUrl(repoUrl: string, sha: string): string {
  const w = repoWebUrl(repoUrl);
  return /(github|gitlab)\.com/i.test(w) ? `${w}/commit/${sha}` : "";
}

/**
 * A one-line markdown source identity: `target · branch @ [shortCommit](url)  (content-id <id>)`.
 * Falls back to `target @ <contentId>` for pre-capture data (no SourceVersion). `includeNote`
 * appends the (often long) provenance note — used in list/summary contexts, not in headings.
 */
export function sourceIdentityMd(
  target: string,
  contentId: string,
  sv?: SourceVersion,
  includeNote = false,
): string {
  if (sv && sv.commit) {
    const cUrl = commitWebUrl(sv.repoUrl, sv.commit);
    const commitMd = cUrl ? `[\`${sv.shortCommit}\`](${cUrl})` : `\`${sv.shortCommit}\``;
    let s = `${target} · ${sv.branch} @ ${commitMd}  (content-id \`${contentId}\`)`;
    if (includeNote && sv.note) s += ` — ${sv.note}`;
    return s;
  }
  return `${target} @ ${contentId}`;
}
