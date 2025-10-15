#!/usr/bin/env node

/**
 * crawler.js - Pure Node.js Web Crawler/Scraper
 *
 * A production-ready web crawler that traverses websites starting from a seed URL,
 * follows links in BFS order, and searches for target patterns across page content.
 *
 * RUN:
 *   node crawler.js --target example.com
 *   node crawler.js --target "/https?:\\/\\/example\\.com\\/foo/" --max-pages 500 --rate 500
 *   node crawler.js --start-url https://seismic.com/ --target example.com --out mapping.json
 *
 * FEATURES:
 *   - Pure Node.js (no external dependencies)
 *   - Respects robots.txt (simple prefix matching for User-agent: *)
 *   - Configurable rate limiting, timeouts, User-Agent, and cookies
 *   - Supports literal substring and regex patterns (wrap in /.../ for regex)
 *   - Case-insensitive matching
 *   - Scans entire raw HTML including inline scripts
 *   - Extracts and tests href/src attributes
 *   - Maps findings to folder paths in JSON output
 *   - BFS traversal with URL normalization and deduplication
 *   - Same-host-only mode (default) or cross-host crawling
 *
 * OUTPUT:
 *   - mapping.json: { "/folder/": [{"page_url":"...","match":"...","snippet":"..."}], ... }
 *   - Folder key rules:
 *       "/" for homepage
 *       "/hello/" for paths like /hello/example.html or /hello/index.html
 *       Trailing slash preserved if present in URL path
 *
 * COMPLIANCE:
 *   - Respects robots.txt disallow rules for User-agent: *
 *   - Does NOT execute JavaScript (static HTML only)
 *   - Configurable rate limiting to avoid overwhelming servers
 *   - Use responsibly and in accordance with website terms of service
 *
 * CLI OPTIONS:
 *   --start-url <url>       Starting URL (default: https://seismic.com/)
 *   --target <pattern>      Target pattern (repeatable; default: example.com)
 *                           Wrap in /.../ for regex, otherwise literal substring
 *   --same-host-only <bool> Restrict to same host (default: true)
 *   --max-pages <int>       Maximum pages to crawl (default: 300)
 *   --rate <ms>             Milliseconds between requests (default: 1000)
 *   --user-agent <string>   User-Agent header (default: InternalCrawler/1.0)
 *   --timeout <seconds>     HTTP timeout in seconds (default: 15)
 *   --out <path>            Output JSON file path (default: mapping.json)
 *   --cookie <string>       Optional Cookie header for authenticated sessions
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

class Crawler {
  constructor(config) {
    this.startUrl = config.startUrl || 'https://seismic.com/';
    this.targetPatterns = config.targetPatterns || ['example.com'];
    this.sameHostOnly = config.sameHostOnly !== false;
    this.maxPages = config.maxPages || 300;
    this.rateMs = config.rateMs || 1000;
    this.userAgent = config.userAgent || 'InternalCrawler/1.0';
    this.timeoutSec = config.timeoutSec || 15;
    this.outputPath = config.outputPath || 'mapping.json';
    this.cookie = config.cookie || null;

    this.visited = new Set();
    this.queue = [];
    this.folderMappings = {};
    this.disallowedPaths = [];
    this.compiledPatterns = [];
    this.pagesCrawled = 0;
    this.totalMatches = 0;
    this.startHost = null;

    this.compilePatterns();
  }

  compilePatterns() {
    for (const pattern of this.targetPatterns) {
      if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
        const regex = pattern.substring(1, pattern.length - 1);
        this.compiledPatterns.push(new RegExp(regex, 'i'));
      } else {
        this.compiledPatterns.push(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      }
    }
  }

  async run() {
    try {
      const startUri = new URL(this.startUrl);
      this.startHost = startUri.hostname;

      console.log('Starting crawler at:', this.startUrl);
      console.log('Target patterns:', this.targetPatterns);
      console.log('Max pages:', this.maxPages);
      console.log();

      await this.fetchRobotsTxt(startUri.protocol + '//' + this.startHost);

      this.queue.push(this.normalizeUrl(this.startUrl));

      while (this.queue.length > 0 && this.pagesCrawled < this.maxPages) {
        const url = this.queue.shift();

        if (this.visited.has(url)) {
          continue;
        }

        if (!this.isAllowedByRobots(url)) {
          console.log('Skipping (robots.txt):', url);
          this.visited.add(url);
          continue;
        }

        this.visited.add(url);
        await this.crawlPage(url);
        this.pagesCrawled++;

        if (this.rateMs > 0 && this.queue.length > 0) {
          await this.sleep(this.rateMs);
        }
      }

      this.writeOutput();
      this.printSummary();

    } catch (error) {
      console.error('Fatal error:', error.message);
      process.exit(1);
    }
  }

  async fetchRobotsTxt(baseUrl) {
    try {
      const robotsUrl = baseUrl + '/robots.txt';
      const content = await this.fetch(robotsUrl);
      this.parseRobotsTxt(content);
      console.log('Loaded robots.txt:', this.disallowedPaths.length, 'disallowed paths');
    } catch (error) {
      console.log('Warning: Could not fetch robots.txt -', error.message);
    }
  }

  parseRobotsTxt(content) {
    let inWildcardSection = false;
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.toLowerCase().startsWith('user-agent:')) {
        const agent = trimmed.substring(11).trim();
        inWildcardSection = agent === '*';
      } else if (inWildcardSection && trimmed.toLowerCase().startsWith('disallow:')) {
        const path = trimmed.substring(9).trim();
        if (path) {
          this.disallowedPaths.push(path);
        }
      }
    }
  }

  isAllowedByRobots(url) {
    try {
      const uri = new URL(url);
      const path = uri.pathname || '/';

      for (const disallowed of this.disallowedPaths) {
        if (path.startsWith(disallowed)) {
          return false;
        }
      }
    } catch {
      return false;
    }
    return true;
  }

  async crawlPage(url) {
    try {
      console.log(`Crawling [${this.pagesCrawled}/${this.maxPages}]:`, url);

      const content = await this.fetch(url);
      const findings = [];

      findings.push(...this.searchContent(url, content));
      findings.push(...this.searchLinks(url, content));

      if (findings.length > 0) {
        const folderKey = this.extractFolderKey(url);
        if (!this.folderMappings[folderKey]) {
          this.folderMappings[folderKey] = [];
        }
        this.folderMappings[folderKey].push(...findings);
        this.totalMatches += findings.length;
        console.log('  Found', findings.length, 'matches');
      }

      this.extractAndQueueLinks(url, content);

    } catch (error) {
      console.error('  Error crawling', url + ':', error.message);
    }
  }

  fetch(url) {
    return new Promise((resolve, reject) => {
      const uri = new URL(url);
      const client = uri.protocol === 'https:' ? https : http;

      const options = {
        method: 'GET',
        headers: {
          'User-Agent': this.userAgent
        },
        timeout: this.timeoutSec * 1000
      };

      if (this.cookie) {
        options.headers['Cookie'] = this.cookie;
      }

      const req = client.get(url, options, (res) => {
        // Follow redirects manually
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          return this.fetch(redirectUrl).then(resolve).catch(reject);
        }

        if (res.statusCode < 200 || res.statusCode >= 400) {
          return reject(new Error(`Status ${res.statusCode}`));
        }

        const contentType = res.headers['content-type'] || '';
        if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) {
          return reject(new Error('Not HTML'));
        }

        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  searchContent(pageUrl, content) {
    const findings = [];

    for (const pattern of this.compiledPatterns) {
      const matches = content.matchAll(new RegExp(pattern.source, 'gi'));
      for (const match of matches) {
        const snippet = this.extractSnippet(content, match.index, 80);
        const fullUrl = this.extractFullUrl(content, match.index);
        findings.push({ page_url: pageUrl, match: match[0], full_url: fullUrl, snippet });
      }
    }

    return findings;
  }

  searchLinks(pageUrl, content) {
    const findings = [];
    const linkPattern = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
    const matches = content.matchAll(linkPattern);

    for (const match of matches) {
      const link = match[1];

      for (const pattern of this.compiledPatterns) {
        if (pattern.test(link)) {
          const snippet = this.extractSnippet(content, match.index, 80);
          const fullUrl = this.resolveUrl(link, pageUrl);
          findings.push({ page_url: pageUrl, match: link, full_url: fullUrl, snippet });
        }
      }
    }

    return findings;
  }

  extractSnippet(content, matchIndex, radius) {
    const start = Math.max(0, matchIndex - radius);
    const end = Math.min(content.length, matchIndex + radius);
    let snippet = content.substring(start, end);
    snippet = snippet.replace(/[\r\n]+/g, ' ').trim();
    return snippet.length > 160 ? snippet.substring(0, 160) : snippet;
  }

  extractFullUrl(content, matchIndex) {
    // Look backward and forward from match to find href or src attribute
    const searchRadius = 200;
    const start = Math.max(0, matchIndex - searchRadius);
    const end = Math.min(content.length, matchIndex + searchRadius);
    const contextChunk = content.substring(start, end);

    // Try to extract URL from href or src attribute
    const urlPattern = /(?:href|src)\s*=\s*["']([^"']+)["']/i;
    const match = contextChunk.match(urlPattern);

    if (match && match[1]) {
      return match[1];
    }

    return null;
  }

  resolveUrl(url, baseUrl) {
    try {
      // If already absolute, return as-is
      if (url.match(/^https?:\/\//i)) {
        return url;
      }
      // Resolve relative URL
      const resolved = new URL(url, baseUrl);
      return resolved.href;
    } catch {
      return url;
    }
  }

  extractAndQueueLinks(baseUrl, content) {
    const linkPattern = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
    const matches = content.matchAll(linkPattern);

    for (const match of matches) {
      const link = match[1];
      try {
        const baseUri = new URL(baseUrl);
        const resolvedUri = new URL(link, baseUri);

        if (!resolvedUri.protocol.match(/^https?:$/)) {
          continue;
        }

        if (this.sameHostOnly && resolvedUri.hostname !== this.startHost) {
          continue;
        }

        const normalized = this.normalizeUrl(resolvedUri.href);
        if (!this.visited.has(normalized) && !this.queue.includes(normalized)) {
          this.queue.push(normalized);
        }

      } catch {
        // Skip invalid URLs
      }
    }
  }

  normalizeUrl(url) {
    try {
      const uri = new URL(url);
      uri.hash = '';
      return uri.href;
    } catch {
      return url;
    }
  }

  extractFolderKey(url) {
    try {
      const uri = new URL(url);
      const path = uri.pathname;

      if (!path || path === '/') {
        return '/';
      }

      if (path.endsWith('/')) {
        return path;
      }

      const lastSlash = path.lastIndexOf('/');
      if (lastSlash >= 0) {
        return path.substring(0, lastSlash + 1);
      }

      return '/';

    } catch {
      return '/';
    }
  }

  writeOutput() {
    const json = JSON.stringify(this.folderMappings, null, 2);
    fs.writeFileSync(this.outputPath, json);
    console.log('\nOutput written to:', this.outputPath);
  }

  printSummary() {
    console.log('\n=== CRAWL SUMMARY ===');
    console.log('Pages crawled:', this.pagesCrawled);
    console.log('Total matches:', this.totalMatches);
    console.log('Folders with matches:', Object.keys(this.folderMappings).length);
    console.log('\nMatches per folder:');

    for (const [folder, findings] of Object.entries(this.folderMappings)) {
      console.log(`  ${folder}: ${findings.length}`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function parseArgs() {
  const config = {
    startUrl: 'https://seismic.com/',
    targetPatterns: [],
    sameHostOnly: true,
    maxPages: 300,
    rateMs: 1000,
    userAgent: 'InternalCrawler/1.0',
    timeoutSec: 15,
    outputPath: 'mapping.json',
    cookie: null
  };

  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--start-url':
        config.startUrl = args[++i];
        break;
      case '--target':
        config.targetPatterns.push(args[++i]);
        break;
      case '--same-host-only':
        config.sameHostOnly = args[++i] !== 'false';
        break;
      case '--max-pages':
        config.maxPages = parseInt(args[++i]);
        break;
      case '--rate':
        config.rateMs = parseInt(args[++i]);
        break;
      case '--user-agent':
        config.userAgent = args[++i];
        break;
      case '--timeout':
        config.timeoutSec = parseInt(args[++i]);
        break;
      case '--out':
        config.outputPath = args[++i];
        break;
      case '--cookie':
        config.cookie = args[++i];
        break;
    }
  }

  if (config.targetPatterns.length === 0) {
    config.targetPatterns.push('example.com');
  }

  return config;
}

// Main execution
if (require.main === module) {
  const config = parseArgs();
  const crawler = new Crawler(config);
  crawler.run().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}

module.exports = Crawler;
