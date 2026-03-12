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
  if (ipLog[ip].length >= 30) {
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
    data_refresh: 'You are a real-time financial data retrieval assistant. You have access to web search. When given a list of financial metrics that failed to load from APIs, you MUST search the web for each one to find the actual current value — do NOT estimate or use training data. Search for prices, yields, and economic releases one by one or in small batches. Once you have confirmed live values from search results, return ONLY a valid JSON object with the data. No markdown, no explanation, no preamble. Every value must come from a real search result with a verifiable source and date.',
  };

  const system = systemMap[type] || systemMap.ai_signal;
  const safeTokens = Math.min(Number(max_tokens) || 1000, (type === 'macro_overview' || type === 'earnings_analysis') ? 1800 : 1200);
  const safePrompt = String(prompt).slice(0, 4000);

  // Log the request
  const ts = Date.now();
  globalLog.push(ts);
  ipLog[ip].push(ts);

  try {
    // data_refresh uses web search so Claude looks up actual live values
    const useWebSearch = (type === 'data_refresh');

    const reqBody = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: safeTokens,
      system,
      messages: [{ role: 'user', content: safePrompt }],
    };

    if (useWebSearch) {
      reqBody.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
      // Allow multiple turns so Claude can search then respond
      reqBody.max_tokens = Math.max(safeTokens, 2000);
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify(reqBody),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', response.status, err);
      return { statusCode: response.status, headers, body: JSON.stringify({ error: 'Upstream error' }) };
    }

    const data = await response.json();

    // For web_search responses, Claude may use tool_use blocks before returning text.
    // Collect all text blocks from the full content array (final answer is last text block).
    let text = '';
    if (useWebSearch && Array.isArray(data.content)) {
      // Extract just the text blocks — skip tool_use and tool_result blocks
      const textBlocks = data.content.filter(b => b.type === 'text').map(b => b.text);
      text = textBlocks[textBlocks.length - 1] || ''; // last text block = final JSON answer
    } else {
      text = data.content?.[0]?.text || '';
    }

    console.log(`[${type}${useWebSearch?' +search':''}] ip=${ip} tokens_in=${data.usage?.input_tokens} tokens_out=${data.usage?.output_tokens}`);

    return { statusCode: 200, headers, body: JSON.stringify({ text }) };

  } catch (err) {
    console.error('Function error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
