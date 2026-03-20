'use strict';

const axios = require('axios');

/**
 * Fetches a URL and returns the response as text the LLM can read.
 * JSON responses are pretty-printed; HTML is stripped to plain text.
 */
async function fetchUrl(url, method = 'GET', headers = {}, body = null) {
  try {
    const config = {
      method: method.toUpperCase(),
      url,
      headers,
      timeout: 30_000,
      // Don't throw on 4xx/5xx so we can return the error body to the LLM
      validateStatus: () => true,
    };
    if (body) {
      config.data = typeof body === 'string' ? body : JSON.stringify(body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        config.headers['Content-Type'] = 'application/json';
      }
    }

    const response = await axios(config);
    const contentType = response.headers['content-type'] || '';
    const status = `HTTP ${response.status} ${response.statusText}`;

    let text;
    if (contentType.includes('application/json') || typeof response.data === 'object') {
      text = JSON.stringify(response.data, null, 2);
    } else {
      text = String(response.data);
      if (contentType.includes('text/html')) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }

    return `${status}\n\n${text.slice(0, 8000)}${text.length > 8000 ? '\n\n[truncated]' : ''}`;
  } catch (err) {
    return `fetch_url error: ${err.message}`;
  }
}

/**
 * Searches the web and returns a text summary of top results.
 * Priority: Brave Search → Google Custom Search → DuckDuckGo instant answers.
 */
async function searchWeb(query) {
  if (process.env.BRAVE_API_KEY) {
    try {
      const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
        params: { q: query, count: 6, text_decorations: false },
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': process.env.BRAVE_API_KEY,
        },
        timeout: 10_000,
      });
      const results = (res.data.web?.results || []);
      if (!results.length) return 'No results found.';
      return results.map((r, i) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description || ''}`
      ).join('\n\n');
    } catch (err) {
      return `search_web (Brave) error: ${err.message}`;
    }
  }

  if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX) {
    try {
      const res = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: {
          key: process.env.GOOGLE_SEARCH_API_KEY,
          cx:  process.env.GOOGLE_SEARCH_CX,
          q:   query,
          num: 6,
        },
        timeout: 10_000,
      });
      const items = res.data.items || [];
      if (!items.length) return 'No results found.';
      return items.map((r, i) =>
        `${i + 1}. **${r.title}**\n   ${r.link}\n   ${r.snippet || ''}`
      ).join('\n\n');
    } catch (err) {
      return `search_web (Google) error: ${err.message}`;
    }
  }

  // Fallback: DuckDuckGo Instant Answer API (free, limited to known entities)
  try {
    const res = await axios.get('https://api.duckduckgo.com/', {
      params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
      timeout: 10_000,
    });
    const d = res.data;
    let result = '';
    if (d.AbstractText) result += `**${d.Heading}**\n${d.AbstractText}\nSource: ${d.AbstractURL}\n\n`;
    if (d.RelatedTopics?.length) {
      result += 'Related:\n' + d.RelatedTopics.slice(0, 4)
        .filter(t => t.Text)
        .map(t => `• ${t.Text}`)
        .join('\n');
    }
    if (!result.trim()) {
      return `No instant answer found for "${query}". Configure BRAVE_API_KEY or GOOGLE_SEARCH_API_KEY in config/.env for full web search.`;
    }
    return result.trim().slice(0, 4000);
  } catch (err) {
    return `search_web error: ${err.message}`;
  }
}

module.exports = { fetchUrl, searchWeb };
