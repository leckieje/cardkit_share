# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

CardKit is a static web application for generating branded SVG news graphics (large numbers, stock cards, watermarked images, etc.) for Dow Jones publications: WSJ, Barron's, MarketWatch, Mansion Global, Moneyish, and WSJ Pro.

## Workflow

1. First, think through the problem. Read the codebase and write a plan in tasks/todo.md.
2. The plan should be a checklist of todo items.
3. Check in with me before starting work—I’ll verify the plan.
4. Then, complete the todos one by one, marking them off as you go.
5. At every step, give me a high-level explanation of what you changed.
6. Keep every change simple and minimal. Avoid big rewrites.
7. At the end, add a review section in todo.md summarizing the changes.

## Rules
1. NEVER move secrets out of .env files or hardcode credentials.
2. Go through the code you just wrote and confirm it follows security best practices. Check that no sensitive data is left in the frontend, and that there are no vulnerabilities an attacker could exploit.

## This is a Build Artifact

This repo contains **pre-compiled output only** — there is no `package.json`, no build tooling, and no source files. All JavaScript and CSS are minified bundles with content-hash filenames (e.g. `scripts/scripts.6dfa87bc.js`). The AngularJS controllers, directives, and SCSS source live in a separate upstream repository. Changes to application logic require rebuilding from source and deploying the new bundles here.

What *can* be modified directly in this repo: `modes/*.config.json`, `views/*.html`, `themes.config.json`, `index.html`, and static assets under `images/`, `logo/`, `fonts/`.

## Running Locally

Any static HTTP server works:

```bash
python3 -m http.server 8080
# or
npx serve .
```

## Architecture

### Data Flow

```
index.html (ui-router)
  → views/<mode>.html          # control panel + <snap-svg> preview
  → modes/<mode>.config.json   # theme/element/size definitions
  → Snap.svg (runtime SVG render)
  → php/makeImages.php → GAMS  # on "Send to GAMS" export
```

### Routing

AngularJS 1.x SPA bootstrapped via `ng-app="cardkitApp"` in `index.html`. UI-Router maps each route (`/big-number`, `/stock`, `/barrons`, etc.) to a view template and loads the corresponding config JSON.

### Modes

Each mode is a pairing of:
- `modes/<name>.config.json` — defines editable elements, theme variants, output sizes, color semantics
- `views/<name>.html` — AngularJS template with left-column controls and right-column `<snap-svg>` live preview

The `<snap-svg>` custom directive reads the config and re-renders the SVG on every model change via two-way `ng-model` bindings.

### Config Schema

Mode configs are arrays of theme objects (typically Light/Dark). Each theme object includes:

| Property | Description |
|---|---|
| `background` | Canvas background hex color |
| `headline` | Default text hex color |
| `primary` | Main text element: `defaultValue`, `fontSize` (min/max), `y`, `tspan[]` for multi-line |
| `secondary` | Secondary text element (same shape as `primary`) |
| `colors` | Semantic palette: `positive`, `negative`, `neutral` hex values |
| `logo` | Logo overlay: `enabled`, `src`, `width`, `height`, `x`, `y`, `opacity` |
| `sizes` | Array of output dimensions `{name, width, height}` driving the size selector |

More complex modes (Barron's, After the Bell) add `secondary1`–`secondary3`, `quote`, `bullet1`–`bullet3`, `fontFamilySerif`, `fontFamilySansSerif`, `shadow`, and `uppercase`.

### themes.config.json

Global library of ~40 named themes used by views that offer a theme picker. Each entry includes `name`, `background`, `headline`, `quote`, `headlineFont`, optional `logoSrc` (base64), `textAnchor`, and `sizes`.

### GAMS Integration

`php/makeImages.php` receives POSTed SVG data, saves it temporarily, and forwards it to the Magnolia GAMS API (`graphicstools.dowjones.net`). `php/testMagnolia.php` is a stub for testing that integration.

## Git Remotes & Pushing Code

This repo has two remotes:
- `origin` — internal DJ GitHub (github.dowjones.net, requires VPN — often unreachable)
- `github` — personal GitHub at https://github.com/leckieje/cardkit_share.git

**Always push to the personal remote:**
```bash
git push github master
```

## Deploying to Cloud Run

The app runs on Cloud Run in GCP project `dj-newsrm-stag-aiml`.

**Live URL:** https://cardkit-wsjpro-673850123387.us-central1.run.app

**Deploy command** (builds remotely via Cloud Build, then deploys):
```bash
cp -r ../google-sheets ./google-sheets && \
gcloud run deploy cardkit-wsjpro \
  --source . \
  --region=us-central1 \
  --project=dj-newsrm-stag-aiml ; \
rm -rf ./google-sheets
```

The `google-sheets/` sibling directory must exist at `../google-sheets` — it's copied into the build context temporarily then cleaned up.

Do NOT use `deploy.sh` in the repo root — it attempts a local Docker push and will fail on permissions.

## Running Locally (Full Stack)

```bash
./start.sh
```

This starts the Node/Express server (port 3001) which serves the static app and proxies to the Flask sheets-service (port 5050). The sheets-service requires a `.env` with GCP credentials.

## Adding or Modifying a Mode

1. Create `modes/<name>.config.json` following an existing config as a template
2. Create `views/<name>.html` following an existing view (e.g. `views/big-number.html` for simple modes, `views/afterthebell.html` for complex ones)
3. Add a nav link in `index.html` using `ui-sref="<name>"` matching the route name
4. Custom AngularJS directives or controllers beyond what the existing bundles provide cannot be added without rebuilding from source
