# Macrodata Refinement

An independent, Severance-inspired browser game. Find unusual four-number patterns, refine them into five bins, and complete a file across four data cycles. A Python object-oriented engine validates every move; a lightweight JavaScript terminal handles the interactive number field.

Includes three shift modes, scoring and streaks, mouse/touch/keyboard controls, a scan assist, saved progress, a local archive, optional procedural sound, reduced motion, and a completion reward. The design uses original CSS/SVG artwork and system fonts, with no third-party media requests.

| Shift       | Time       | File closes on |
| ----------- | ---------- | -------------- |
| Orientation | Unlimited  | 8th mistake    |
| Standard    | 15 minutes | 5th mistake    |
| Overtime    | 8 minutes  | 3rd mistake    |

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

Open http://127.0.0.1:5000. A Standard shift starts automatically. Use **Open a file** to choose another mode or assignment. Click a glowing group, then click the indicated bin or press 1–5. Arrow keys navigate the field; Space selects; Escape clears. The employee handbook explains the rules in the game.

Progress is saved in the current browser. A timed shift continues while a dialog or another tab is open. Saved tokens expire after 24 hours without refresh. The archive keeps the last 30 closed files.

## Verify

```sh
python -m pytest --cov=mdr --cov=app --cov-report=term-missing
npm ci
npm run test:coverage
npx playwright install chromium
npm run test:browser
```

Python tests enforce 100% statement and branch coverage. Separate audits require dedicated behavioral tests for each handwritten Python function and each browser class method. Browser tests run against the real Flask API on desktop and mobile viewports, including a complete file, save recovery, failure, keyboard input, pointer selection, settings, and automated accessibility checks.

## Deploy to Vercel

1. Import this repository into Vercel and use its root as the project root. For the complete unmerged implementation, deploy the final branch in the PR stack.
2. Use the checked-in Flask configuration. `app.py` exports the application and `public/` contains browser assets.
3. Set a stable, randomly generated `MDR_SECRET_KEY` for Preview and Production. Use different values for those environments. Generate one locally with `python -c "import secrets; print(secrets.token_urlsafe(48))"` and enter it in Vercel's environment settings; never commit it.
4. Deploy, check `/api/health`, then refine a group and reload to verify the save.

The API returns 503 if a hosted deployment lacks a suitable secret. Local development has a stable development-only fallback. No database is required: Vercel workers verify signed state supplied by the browser. This follows [Vercel's Flask hosting layout](https://vercel.com/docs/frameworks/backend/flask) and [Python runtime configuration](https://vercel.com/docs/functions/runtimes/python).

The tokens are signed, not encrypted. Puzzle geometry is visible to the browser, and an old valid token can replay an earlier state. This is a personal puzzle game, with no verified leaderboard or cross-device save service.

## Project boundaries

`mdr/` contains the domain model and session codec. `app.py` provides the Flask API. `templates/` and `public/assets/` contain the browser terminal. `tests/` contains backend, browser-unit, and end-to-end tests.

Detailed owner documentation and editable draw.io diagrams are deliberately kept outside this public repository and deployment. This README contains only public setup information.

This is an unofficial fan project, unaffiliated with Apple, the show, or its creators. The repository's license covers its original code, not third-party trademarks or television intellectual property.
