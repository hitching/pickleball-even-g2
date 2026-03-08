# pickleball-even-g2

Pickleball scoring and assistant app for Even Realities G2 smart glasses.

## Development environment

This app runs inside **even-dev**, a multi-app simulator environment located at:

```
/Users/ritahitching/even-dev
```

To launch this app via even-dev:

```bash
cd /Users/ritahitching/even-dev
./start-even.sh pickleball
```

This app is registered as a local path in `/Users/ritahitching/even-dev/apps.json`:

```json
"pickleball": "/Users/ritahitching/pickleball-even-g2"
```

Even-dev serves this app's `index.html` through its Vite dev server with the Even Hub Simulator attached.

## Key documentation

- **G2 development notes** (reverse-engineered SDK reference): https://github.com/nickustinov/even-g2-notes/blob/main/G2.md
- **even-dev README**: `/Users/ritahitching/even-dev/README.md` — explains how apps are loaded, the built-in app contract, external apps, and Vite plugins

## even-dev sample apps to reference

All sample apps are in `/Users/ritahitching/even-dev/apps/`. Key examples:

| App | Path | What it demonstrates |
|-----|------|----------------------|
| `base_app` | `/Users/ritahitching/even-dev/apps/base_app/` | Full pattern: bridge init, `createStartUpPageContainer`, text + list containers, event handling, browser UI panel, mock fallback |
| `timer` | `/Users/ritahitching/even-dev/apps/timer/` | Countdown timer — text container updates, click/double-click events |
| `clock` | `/Users/ritahitching/even-dev/apps/clock/` | Periodic refresh with `textContainerUpgrade` |
| `restapi` | `/Users/ritahitching/even-dev/apps/restapi/` | REST API calls, multi-file structure, model/ui separation |

Shared types used by built-in apps: `/Users/ritahitching/even-dev/apps/_shared/app-types.ts`

> Note: built-in apps export an `AppModule` from `index.ts` and share even-dev's `index.html`/`src/main.ts` loader. This app is an **external** standalone app with its own `index.html` and `src/main.ts` — do not copy the `AppModule` pattern.

## G2 display constraints (critical)

- Canvas: **576×288 px** per eye, 4-bit greyscale (16 shades of green)
- Max **4 containers per page** (text, list, or image)
- Exactly **one** container must have `isEventCapture: 1`
- No CSS, no flexbox — containers are positioned with pixel coordinates
- Text is left-aligned only, single fixed font, `\n` for line breaks
- List containers: max 20 items, firmware handles scroll highlighting natively
- `CLICK_EVENT = 0` normalises to `undefined` — always check both

## SDK

```bash
npm install @evenrealities/even_hub_sdk
```

Bridge init in `src/main.ts`:

```ts
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
const bridge = await waitForEvenAppBridge()
```

## npm scripts

```bash
npm run dev    # Vite dev server (usually launched via even-dev, not directly)
npm run build  # production build
npm run qr     # QR code for Even App on phone
npm run pack   # build + package as pickleball.ehpk
```
