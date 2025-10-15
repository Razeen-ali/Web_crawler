# Web Crawler

A Node.js web crawler that searches for patterns across websites.

## Usage Examples

```bash
# Basic crawl with default settings
node crawler.js --target example.com

# Search for a specific pattern with custom limits
node crawler.js --target "linkedin.com" --max-pages 50 --rate 500

# Use regex pattern
node crawler.js --target "/https?:\\/\\/example\\.com\\/[a-z]+/" --max-pages 100

# Multiple targets
node crawler.js --target twitter.com --target facebook.com --target linkedin.com

# Custom start URL
node crawler.js --start-url https://example.com/ --target "api" --max-pages 20

# Save to custom output file
node crawler.js --target "contact" --out results.json

# Test run (quick preview with 10 pages)
node crawler.js --target example.com --max-pages 10 --rate 200
```

## CLI Options

- `--start-url <url>` - Starting URL (default: https://seismic.com/)
- `--target <pattern>` - Target pattern to search for (repeatable)
- `--same-host-only <bool>` - Only crawl same domain (default: true)
- `--max-pages <int>` - Maximum pages to crawl (default: 300)
- `--rate <ms>` - Delay between requests in milliseconds (default: 1000)
- `--user-agent <string>` - Custom User-Agent header
- `--timeout <seconds>` - Request timeout (default: 15)
- `--out <path>` - Output JSON file path (default: mapping.json)
- `--cookie <string>` - Cookie header for authenticated sessions

## Output

Creates `mapping.json` with structure:
```json
{
  "/folder/": [
    {
      "page_url": "https://example.com/folder/page.html",
      "match": "example.com",
      "snippet": "...context around match..."
    }
  ]
}
```
