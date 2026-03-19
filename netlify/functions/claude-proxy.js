const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Simple in-memory rate limiting
const ipLog = {};
const globalLog = [];

function cleanOld(arr) {
  const cutoff = Date.now() - 3600000;
  while (arr.length && arr[0] < cutoff) arr.shift();
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  // Global rate limit - 500/hour
  cleanOld(globalLog);
  if (globalLog.length >= 500) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Service busy, try again soon' }) };
  }

  // Per-IP rate limit - 20/hour
  const ip = event.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  if (!ipLog[ip]) ipLog[ip] = [];
  cleanOld(ipLog[ip]);
  if (ipLog[ip].length >= 20) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Rate limit reached, try again in an hour' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  const { type, prompt, max_tokens = 1000, seriesId, limit } = body;

  // ── Yahoo Finance proxy — avoids browser CORS issues
  if (type === 'yahoo') {
    const { ticker } = body;
    if (!ticker) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing ticker' }) };
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return { statusCode: r.status, headers, body: JSON.stringify({ error: 'Yahoo error' }) };
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (!meta) return { statusCode: 404, headers, body: JSON.stringify({ error: 'No data' }) };
      const price = meta.regularMarketPrice ?? meta.previousClose;
      const prevClose = meta.chartPreviousClose ?? meta.previousClose;
      if (!price) return { statusCode: 404, headers, body: JSON.stringify({ error: 'No price' }) };
      return { statusCode: 200, headers, body: JSON.stringify({
        price: parseFloat(price),
        prevClose: parseFloat(prevClose),
        change: price - prevClose,
        changePct: ((price - prevClose) / prevClose) * 100,
      })};
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── FRED proxy — routes FRED API calls server-side to avoid browser CORS
  if (type === 'fred') {
    if (!seriesId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing seriesId' }) };
    const FRED_KEY = 'b0a6e25d3c3e7ce883de9c27dfbbb5e4';
    const fredUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=${limit || 26}`;
    try {
      const r = await fetch(fredUrl);
      if (!r.ok) return { statusCode: r.status, headers, body: JSON.stringify({ error: 'FRED error' }) };
      const d = await r.json();
      return { statusCode: 200, headers, body: JSON.stringify(d) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (!prompt || !type) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing prompt or type' }) };
  }

  const systemMap = {
    breaking_news:     'You are a financial news analyst. Search the web for real breaking macro news. Return only valid JSON arrays, no markdown.',
    earnings_dates:    'You are a financial data assistant. Search the web for real earnings data. Return only valid JSON, no markdown.',
    earnings_analysis: 'You are a senior equity strategist. Write compressed, high-signal earnings analysis. No markdown, no preamble.',
    ai_signal:     'You are a synthesis of Ray Dalio, Stan Druckenmiller, George Soros, Paul Tudor Jones, and Howard Marks. Write compressed, high-signal macro analysis. Be direct and actionable. No preamble.',
    news_classify: 'You are a macro trading desk analyst. Classify headlines by market impact. Return only valid JSON, no markdown.',
    news_enrich:   'You are a macro trading desk analyst. Give brief actionable trading insights. Return only valid JSON, no markdown.',
  };

  const system = systemMap[type] || systemMap.ai_signal;

  // breaking_news and earnings_dates need live web search for real-time data
  // All other types receive their data in the prompt — no search needed
  // Haiku handles both well: factual lookups (earnings/news) and text analysis (ai_signal etc.)
  const SEARCH_TYPES = new Set(['breaking_news', 'earnings_dates']);
  const useSearch = SEARCH_TYPES.has(type);
  const model = 'claude-haiku-4-5';
  const tokenCap = useSearch ? 1500 : 800;
  const safeTokens = Math.min(Number(max_tokens) || 1000, tokenCap);
  const safePrompt = String(prompt).slice(0, 4000);

  // Log the request
  const ts = Date.now();
  globalLog.push(ts);
  ipLog[ip].push(ts);

  const requestBody = {
    model,
    max_tokens: safeTokens,
    system,
    messages: [{ role: 'user', content: safePrompt }],
  };
  if (useSearch) {
    requestBody.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', response.status, err);
      return { statusCode: response.status, headers, body: JSON.stringify({ error: 'Upstream error' }) };
    }

    const data = await response.json();
    // Web search returns multiple content blocks — find the last text block
    const textBlock = (data.content || []).filter(b => b.type === 'text').pop();
    const text = textBlock?.text || '';
    console.log(`[${type}] ip=${ip} tokens_in=${data.usage?.input_tokens} tokens_out=${data.usage?.output_tokens}`);

    return { statusCode: 200, headers, body: JSON.stringify({ text }) };

  } catch (err) {
    console.error('Function error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
