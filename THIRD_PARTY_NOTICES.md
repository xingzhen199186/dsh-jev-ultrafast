# Third-party notices

This package is an independent, unofficial port. It is **not** affiliated with,
endorsed by, or sponsored by Browser Use or TypeSafe.

## jev-ultrafast — MIT

- Upstream: <https://github.com/browser-use/jev-ultrafast>
- Copyright (c) 2026 Browser Use
- License: MIT (full text reproduced in `LICENSE`)

Material derived from this project and carried over into this package:

| Upstream | Here | Nature of reuse |
|---|---|---|
| `jev_ultrafast/snapshot.js` | `src/browser/snapshot.js` | The in-page DOM snapshot script, carried over essentially verbatim |
| `jev_ultrafast/questions.py` | `src/prompts.ts` | The policy prompts (next-action rules, target selection, field-value rules), carried over essentially verbatim |
| `jev_ultrafast/model.py` | `src/decision/*` | Ported logic: indexed action space, single-request operation + target decision, response validation |
| `jev_ultrafast/agent.py` | `src/loop.ts` | Ported logic: loop bounds, stale-decision handling, text-value caching, log-before-observe |
| `jev_ultrafast/browser.py` | `src/browser/*` | Ported logic: freshness guards and pre-action visibility/geometry checks |
| `jev_ultrafast/static/fixture.html` | `tests/fixture/fixture.html` | The local test page used for offline verification |

The upstream Python dependencies (`browser-harness`, `cdp-use`, `fetch-use`,
`httpx`) are **not** redistributed here. The browser transport was re-implemented
in TypeScript against the Chrome DevTools Protocol.

## TypeSafe Jev — external service, not redistributed

This package contains no TypeSafe code, model weights, or credentials. It calls
the user's own TypeSafe endpoint with the user's own API key, resolved at
runtime from the DeepSeek Harness credential store.

- Terms of service: <https://typesafe.ai/legal/terms>
- Acceptable use policy: <https://typesafe.ai/legal/acceptable-use-policy>
- Model commercial agreement: <https://typesafe.ai/legal/mca>

Nothing in this package's MIT license grants rights to the TypeSafe service, its
models, or its marks. Use of that service is governed solely by those terms.

## Trademarks

"Browser Use", "TypeSafe", and "Jev" are the property of their respective
owners. They appear in this package only to describe provenance and the API the
plugin talks to. No trademark license is granted.
