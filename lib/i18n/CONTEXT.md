# Interface localization

## Public API

- `shared.ts`: locale validation, typed message keys, complete-template interpolation.
- `server.ts`: request-scoped `getServerI18n()` reads `banking_locale` through Next cookies.
- `LocaleProvider.tsx`: client translation context, cookie persistence, server-component refresh.
- `LocaleText.tsx`: a client leaf for server-safe primitives with render callbacks.
- `messages/`: paired Chinese and English catalogs for app chrome, chat, business and pages.

## Rules

- Default to `zh-CN`, including on browsers that prefer English. Only `en` selects English.
- Keep identifiers, keys and comments in English. Chinese interface text belongs in locale JSON.
- Translate full templates. Pass financial values as already formatted exact strings.
- Do not convert money to binary numbers for interpolation or locale formatting.
- Localize static interface metadata; preserve recorded user text, model replies and financial facts.
- Language switching updates presentation only. Do not remount chat, resubmit operations or change authorization.
- The preference cookie is not an identity cookie and grants no permission.
- Keep server data access in server modules; localization does not justify client-side database imports.
- Register both catalog entries together; unit tests enforce key and placeholder parity.

## Verification

`tests/unit/lib/i18n.test.ts` checks catalogs and interpolation. The real-browser acceptance
journey checks defaults, persistence, client/server translation and conversation preservation.
