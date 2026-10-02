/**
 * The page-side check for a human-verification page: a CAPTCHA, or a bot-detection interstitial.
 *
 * Ported from the sibling implementation (`dsh-browser`, `src/browser-electron/provider.ts:61-107`),
 * which runs an expression of this shape in the page and folds the answer into every observation. It
 * is marker-based and best-effort by construction: it reads the page's own words, the ids its
 * interstitials are known by, the challenge libraries' globals, and the addresses of the frames they
 * are served from. It fills nothing in, clicks nothing, and never fails an observation — a page it
 * cannot read is a page with no challenge to name.
 *
 * What it deliberately does not do is decide whether a run should stop. That is the loop's question,
 * and it is asked of a page that is both challenged *and* going nowhere (`challengeStopping` in
 * `../loop.ts`), because this is a marker heuristic and its weakest hits are only "a challenge widget
 * is somewhere on this page" — every login page that carries a reCAPTCHA badge answers that way.
 */

/** The markers this check knows by name, in the order it asks about them. */
export type ChallengeKind = 'cloudflare' | 'hcaptcha' | 'recaptcha' | 'turnstile' | 'generic'

/** What the page-side check found: which marker fired, and what it saw, in its own words. */
export interface PageChallenge {
  kind: ChallengeKind
  /**
   * The check's own account of what it saw, in English, as the sibling implementation writes it:
   * evidence for the run's trace rather than a sentence for the user, who is told what the page is
   * in `../loop.ts`'s words.
   */
  reason: string
}

const KINDS: readonly ChallengeKind[] = ['cloudflare', 'hcaptcha', 'recaptcha', 'turnstile', 'generic']

/**
 * The check, as the page runs it: one expression, answering `{blocked, kind?, reason?}`.
 *
 * Written with `String.raw` because it is injected as text (no bundling, no reformatting), and
 * without a backtick or a `${` for the same reason the snapshot is: the raw template is
 * byte-faithful only while the body stays free of both.
 *
 * Challenge widgets hide in two places a `document.body.innerText` never reaches, and both are
 * looked into: open shadow roots, and same-origin frames. A frame from another origin cannot be read
 * at all — the browser throws on `contentDocument` — so it is left opaque and the check goes on,
 * which is the whole reason the two `try` blocks are here: a page this check cannot finish reading is
 * not a page that failed, it is a page nothing was found on.
 *
 * The text it reads is bounded at 4000 characters for the document and 2000 per shadow root or
 * frame, so a page built out of a million nodes cannot turn one observation into a transcript.
 */
export const CHALLENGE_SOURCE = String.raw`(() => {
  const title = (document.title || '') + '\n';
  const shown = ((document.body && document.body.innerText) || '').slice(0, 4000);
  let extra = '';
  try {
    const seen = new Set();
    const scan = (root) => {
      if (!root || seen.has(root)) return;
      seen.add(root);
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          extra += (el.shadowRoot.textContent || '').slice(0, 2000);
          scan(el.shadowRoot);
        }
        if (el.tagName === 'IFRAME') {
          try {
            const inner = el.contentDocument;
            if (inner) {
              extra += ((inner.body && inner.body.innerText) || '').slice(0, 2000);
              scan(inner);
            }
          } catch (error) {
            // Cross-origin: the frame stays opaque and the check goes on without it.
          }
        }
      }
    };
    scan(document);
  } catch (error) {
    // A page that cannot be walked is a page with nothing to name.
  }
  const lower = (title + shown + '\n' + extra).toLowerCase();
  let frames = '';
  try {
    for (const frame of document.querySelectorAll('iframe')) frames += ' ' + (frame.src || '');
  } catch (error) {
    // Same again: no frame addresses is one marker fewer, not a failure.
  }
  frames = frames.toLowerCase();
  const interstitial = /just a moment|checking your browser|attention required|cf_chl/.test(lower) ||
    !!document.querySelector('#challenge-running, #challenge-stage, #cf-chl-container');
  const hcaptcha = !!window.hcaptcha || !!document.querySelector('.h-captcha') || frames.includes('hcaptcha.com');
  const recaptcha = !!window.grecaptcha || !!document.querySelector('.g-recaptcha') ||
    /recaptcha\/api|google\.com\/recaptcha/.test(frames);
  const turnstile = !!window.turnstile || frames.includes('challenges.cloudflare.com') ||
    /turnstile|challenge-platform/.test(lower);
  const wording = /verify you are human|verify you are not a robot|enable javascript and cookies|人机验证|安全验证|请.*验证/.test(lower);
  if (interstitial) return {blocked: true, kind: 'cloudflare', reason: 'Cloudflare interstitial ("Just a moment")'};
  if (hcaptcha) return {blocked: true, kind: 'hcaptcha', reason: 'hCaptcha widget on the page'};
  if (recaptcha) return {blocked: true, kind: 'recaptcha', reason: 'Google reCAPTCHA widget on the page'};
  if (turnstile) return {blocked: true, kind: 'turnstile', reason: 'Cloudflare Turnstile widget on the page'};
  if (wording && /challenge|captcha|verification|security check|access denied|blocked|验证/.test(lower)) {
    return {blocked: true, kind: 'generic', reason: 'Challenge wording in the page text'};
  }
  return {blocked: false};
})()`

/**
 * The page-side answer, read as an observation carries it: a challenge, or nothing at all.
 *
 * Nothing at all is the answer for everything that is not one of the five markers by name — an answer
 * that never arrived, a page-side copy that came back in another shape, a value that is not even an
 * object. Failing towards "no challenge" is the only safe direction for a check that can stop runs:
 * the cost of missing one is the ending the run had before this check existed, and the cost of
 * inventing one is a run stopped on a page that was fine. The `blocked` flag itself is therefore not
 * enough — a kind this file does not know is not a kind the report knows words for.
 */
export function asChallenge(value: unknown): PageChallenge | null {
  if (typeof value !== 'object' || value === null) return null
  const said = value as { blocked?: unknown; kind?: unknown; reason?: unknown }
  if (said.blocked !== true) return null
  const kind = KINDS.find((known) => known === said.kind)
  if (kind === undefined) return null
  return { kind, reason: typeof said.reason === 'string' && said.reason ? said.reason : kind }
}
