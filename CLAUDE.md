# Macro Demon — Project Context

## What This Is
Macroeconomic monitoring and trading intelligence dashboard. Synthesizes real-time data from FRED, Yahoo Finance, Finnhub, crypto exchanges, and NewsData.io. Uses Claude AI for breaking news discovery, regime analysis, and trade signal synthesis.

## Tech Stack
- **Frontend**: Single HTML file (vanilla JS + CSS, no build system)
- **Backend**: Netlify Functions (Node.js serverless)
- **AI**: Claude Haiku 4.5 with web_search tool
- **Charts**: Chart.js (candlestick/OHLC with zoom/pan)
- **Fonts**: Bebas Neue, IBM Plex Mono, IBM Plex Sans
- **Hosting**: Netlify (github.com/Mireri1/Macro-Demon)

## Architecture

### Two Files
- `index.html` — entire app (~3,500 lines of HTML/CSS/JS)
- `netlify/functions/claude-proxy.js` — API gateway + rate limiter (~256 lines)

### Data Flow
1. Browser fetches market data directly from public APIs (FRED, Yahoo, crypto exchanges)
2. AI-powered features (breaking news, signal synthesis) go through the Netlify function
3. Netlify function proxies to Claude API (keeps API key server-side)
4. All data cached in localStorage with TTLs

### No Database
Everything is ephemeral. FRED data cached 6 hours, news cached 60 minutes, breaking news cached 2 hours. All in browser localStorage.

## Dashboard Sections

1. **Vibe Bar** — RISK ON / RISK OFF / TRANSITION sentiment with driver pills
2. **Breaking News Ticker** — auto-scrolling, updated hourly via Claude web search
3. **Macro Regime Banner** — GOLDILOCKS / LATE CYCLE / OVERHEATING / STAGFLATION / CONTRACTION / DEFLATION RISK / RECESSION / TRANSITIONAL
4. **Markets** — S&P 500, Nasdaq, Dow, Gold, BTC, ETH, SOL, Total Crypto MCap
5. **Growth & Activity** — GDP, unemployment, payrolls, ISM PMI, retail sales, industrial production
6. **Inflation & Rates** — CPI, Core CPI, PCE, breakeven inflation, Fed Funds, real 10Y
7. **Liquidity & Credit** — M2, Fed balance sheet, HY spreads, FX pairs, DXY, mortgage rates
8. **Risk & Sentiment** — VIX, financial stress index, yield curve (10Y-2Y, 10Y-3M), oil
9. **Yield Curve Chart** — 3M, 2Y, 5Y, 10Y, 30Y yields
10. **Spreads Chart** — IG and HY OAS (5-day rolling)
11. **Scorecard** — numerical regime detection (Growth/Inflation/Liquidity/Risk 0-100)
12. **News Tabs** — Breaking, Growth, Inflation, Liquidity, Risk (cached per tab)
13. **Trading Chart** — interactive OHLC with drawing tools + technical indicators (EMA, Bollinger, VWAP, RSI, MACD, ATR, Stochastic)

## Regime Detection Logic
4-quadrant scoring system:
- Growth score (0-100)
- Inflation score (0-100)
- Liquidity score (0-100)
- Risk score (0-100)

Average determines regime. Each regime has a trading playbook (long equity, reduce leverage, buy commodities, etc.).

## Netlify Function (claude-proxy.js)

### Request Types
| Type | Purpose | Uses Web Search |
|------|---------|----------------|
| `yahoo` | Stock/futures quote proxy | No |
| `yahoo_earnings` | Single ticker earnings | No |
| `yahoo_earnings_batch` | Batch earnings (parallel) | No |
| `fred` | FRED economic data series | No |
| `breaking_news` | Live macro news via Claude | Yes |
| `ai_signal` | Macro regime synthesis | No |
| `news_classify` | Classify headlines by category | No |
| `news_enrich` | Add trading insights to headlines | No |

### Rate Limiting
- Global: 500 requests/hour
- Per-IP: 20 requests/hour
- In-memory tracking (resets on cold start)

## Data Sources & Fallbacks

### Multi-Exchange Crypto
Tries 6 exchanges in parallel, uses first successful:
Kraken → Coinbase → CoinCap → ByBit → OKX → MEXC

### Graceful Degradation
1. Try primary API
2. Try fallback API
3. Show demo data (realistic Feb 2025 values)
4. UI indicates "LIVE DATA" vs "DEMO DATA"

## Key Patterns

### Signal Color Coding
All metrics map to standardized signals:
- `sb` — strong/bullish (green)
- `sc` — caution (yellow)
- `sr` — risk/red
- `sn` — neutral (gray)

### FRED Calculations
- `level` — raw value (unemployment rate)
- `delta` — month-over-month change (payrolls)
- `yoy` — year-over-year % change (CPI)

### Parallel Loading
All sections load simultaneously via `Promise.all()` — markets, growth, inflation, liquidity, risk all fetch in parallel.

### Trading Chart Dual-Canvas
- Main canvas: OHLC data rendering
- Overlay canvas: user drawings (trendlines, horizontals, range boxes)
- Separates data from annotations for performance

## Client-Side Config
```javascript
const CONFIG = {
  FRED_API_KEY: '...',        // St. Louis Fed
  GNEWS_API_KEY: '...',       // NewsData.io
  FINNHUB_API_KEY: '...',     // Finnhub stock data
  ALPHA_VANTAGE_KEY: '...',   // Alpha Vantage
};
```
When FRED key is placeholder, demo mode activates automatically.

## Environment Variables (Netlify)
- `ANTHROPIC_API_KEY` — required for Claude API calls (server-side only)

## Auto-Refresh
- Markets: every 5 minutes
- Breaking news: every 60 minutes
- News tabs: on-demand with 60-minute cache
- Manual refresh button available

## Key Files
- `index.html` — entire frontend application
- `netlify/functions/claude-proxy.js` — serverless API gateway
