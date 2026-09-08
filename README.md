# Macrodata Refinement

An independent, Severance-inspired browser game. Explore a full-screen terminal containing 40,960 animated numbers. Discover irregular groups, let them gather around your pointer, and click to send them automatically to the correct bin. A Python object-oriented engine validates each move; a Canvas 2D terminal renders only the visible part of the world.

Clusters contain 3–18 numbers with variable shapes and scores. Gathering takes 1.5 seconds; captured digits refill immediately while copies animate into the bins. Drag to explore, zoom around your pointer, or use touch and keyboard navigation. Includes saved camera/progress, a local archive, optional sound and reduced motion. No third-party media requests or frontend build step.

| Gameplay | Objective |
| --- | --- |
| Quota | Refine 100 numbers into each of five bins, untimed |
| Timed shift | Meet the same quotas within 15 minutes |
| Endless | Complete repeating quota cycles without a timer |

Choose difficulty independently: **Normal** has no ordinary-click penalty; **Quota achiever** subtracts up to 50 points; **Refiner of the quarter** ends the run on the third strike. Early clicks while a scary group is gathering are harmless in every difficulty.

## Run locally

Python 3.12 is required. Node 24 is used for browser development checks only.

```sh
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python -m flask --app app run
```

Open http://127.0.0.1:5000. An untimed Normal assignment starts automatically. Use **[ FILE ]** to choose another mode and difficulty. Hover for 1.5 seconds, then click a gathered group; on touch, hold and release. Drag or use arrows/WASD to navigate. Scroll/pinch or +/− to zoom. F cycles signals already visible in the viewport; Enter/Space refines after gathering. **[ ? ]** opens the complete protocol.

Progress and camera position save in this browser. Timed shifts continue while away. Signed tokens expire after 24 hours without refresh. The log keeps the last 30 closed files. V2 saves use separate keys and signing format; original v1 saves remain untouched, with a local backup when storage permits.

## Verify

```sh
python -m pytest --cov=mdr --cov=app --cov-report=term-missing
npm ci
npm run test:coverage
npx playwright install chromium
npm run test:browser
```

Python tests enforce 100% statement and branch coverage. Separate audits require dedicated behavioral tests for each handwritten Python function and each browser class method. Browser tests use the real Flask API on port 5001 with desktop and mobile viewports, including hover/capture/refill, navigation, persistence, difficulty settings, keyboard/touch controls and automated accessibility checks.

## Deploy to Vercel

1. Import this repository into Vercel and use its root as the project root. For the complete unmerged implementation, deploy the final branch in the PR stack.
2. Use the checked-in Flask configuration. `app.py` exports the application and `public/` contains browser assets.
3. Set a stable, randomly generated `MDR_SECRET_KEY` for Preview and Production. Use different values for those environments. Generate one locally with `python -c "import secrets; print(secrets.token_urlsafe(48))"` and enter it in Vercel's environment settings; never commit it.
4. Deploy, check `/api/health`, then refine a group and reload to verify the save.

The API returns 503 if a hosted deployment lacks a suitable secret. Local development has a stable development-only fallback. No database is required: Vercel workers verify signed state supplied by the browser. This follows [Vercel's Flask hosting layout](https://vercel.com/docs/frameworks/backend/flask) and [Python runtime configuration](https://vercel.com/docs/functions/runtimes/python).

The tokens are signed, not encrypted. Puzzle geometry is visible to the browser, and an old valid token can replay an earlier state. This is a personal puzzle game, with no verified leaderboard or cross-device save service.

## Project boundaries

`mdr/world.py` contains the v2 domain model and signed session codec. `app.py` provides `/api/v2/session`, `/restore`, `/capture` and `/mistake`. `templates/terminal.html`, `public/assets/terminal.js`, `field.js` and `session.js` implement the terminal. `tests/` contains backend, browser-unit and end-to-end tests. The v1 engine/API and original browser assets remain covered for compatibility but are not loaded by the new interface.

Detailed owner documentation and editable draw.io diagrams are deliberately kept outside this public repository and deployment. This README contains only public setup information.

This is an unofficial fan project, unaffiliated with Apple, the show, or its creators. The repository's license covers its original code, not third-party trademarks or television intellectual property.
