const { requireAuth } = require('../lib/auth');

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  const fredKey = process.env.FRED_API_KEY;
  const log = [];

  log.push(`FRED_API_KEY present: ${!!fredKey}`);
  log.push(`FRED_API_KEY length: ${fredKey ? fredKey.length : 0}`);
  log.push(`FRED_API_KEY first 4 chars: ${fredKey ? fredKey.substring(0, 4) : 'n/a'}`);
  log.push(`FRED_API_KEY has whitespace: ${fredKey ? fredKey !== fredKey.trim() : 'n/a'}`);

  // Test a simple FRED call and return the full response
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${fredKey}&file_type=json&sort_order=desc&limit=3`;

  log.push(`Request URL (key masked): ${url.replace(fredKey, 'KEY_HIDDEN')}`);

  try {
    const response = await fetch(url);
    log.push(`Response status: ${response.status}`);
    log.push(`Response headers content-type: ${response.headers.get('content-type')}`);

    const text = await response.text();
    log.push(`Response body (first 500 chars): ${text.substring(0, 500)}`);

    // Try parsing as JSON
    try {
      const json = JSON.parse(text);
      log.push(`Parsed JSON keys: ${Object.keys(json).join(', ')}`);
      if (json.error_message) {
        log.push(`FRED error_message: ${json.error_message}`);
      }
      if (json.error_code) {
        log.push(`FRED error_code: ${json.error_code}`);
      }
    } catch {
      log.push('Response is not JSON — may be XML or HTML error page');
    }
  } catch (err) {
    log.push(`Fetch error: ${err.message}`);
  }

  return res.status(200).json({ log });
};
