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

  const { type, prompt, max_tokens = 1000 } = body;
  if (!prompt || !type) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing prompt or type' }) };
  }

  const systemMap = {
    ai_signal:      'You are a synthesis of Ray Dalio, Stan Druckenmiller, George Soros, Paul Tudor Jones, and Howard Marks. Write compressed, high-signal macro analysis. Be direct and actionable. No preamble.',
    news_classify:  'You are a macro trading desk analyst. Classify headlines by market impact. Return only valid JSON, no markdown.',
    news_enrich:    'You are a macro trading desk analyst. Give brief actionable trading insights. Return only valid JSON, no markdown.',
    macro_overview:     'You are a senior macro strategist combining the frameworks of Ray Dalio (All Weather, debt cycles), Stan Druckenmiller (liquidity and momentum), George Soros (reflexivity), Paul Tudor Jones (risk management), and Howard Marks (market cycles). Write in precise, institutional-grade prose. No bullet points. No markdown. No preamble. Deliver analytical paragraphs that a hedge fund PM would find actionable. Be direct about positioning implications.',
    earnings_analysis:  'You are a senior equity strategist and earnings analyst with expertise across all GICS sectors. Write in clear, institutional-grade prose. No markdown, no bullet points, no headers, no preamble. Deliver sharp, specific analysis — name tickers, cite numbers, and connect corporate results to the broader macro picture. Be direct about what the data means for sector rotation and forward positioning.',
  };

  const system = systemMap[type] || systemMap.ai_signal;
  const safeTokens = Math.min(Number(max_tokens) || 1000, (type === 'macro_overview' || type === 'earnings_analysis') ? 1800 : 1200);
  const safePrompt = String(prompt).slice(0, 4000);

  // Log the request
  const ts = Date.now();
  globalLog.push(ts);
  ipLog[ip].push(ts);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: safeTokens,
        system,
        messages: [{ role: 'user', content: safePrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', response.status, err);
      return { statusCode: response.status, headers, body: JSON.stringify({ error: 'Upstream error' }) };
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    console.log(`[${type}] ip=${ip} tokens_in=${data.usage?.input_tokens} tokens_out=${data.usage?.output_tokens}`);

    return { statusCode: 200, headers, body: JSON.stringify({ text }) };

  } catch (err) {
    console.error('Function error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
