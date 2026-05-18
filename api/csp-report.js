// Vercel Edge Function — modtager CSP violation reports.
//
// Browsere POST'er hertil når en ressource overtræder vores
// Content-Security-Policy-Report-Only header. Vi logger violations
// til console (synligt i Vercel Logs) så vi opdager faktiske brud
// FØR vi flipper CSP til enforcement-mode.
//
// To formater understøttes:
//   1. Klassisk: Content-Type: application/csp-report (report-uri)
//   2. Nyt:      Content-Type: application/reports+json (report-to)
//
// Begge logges struktureret med blocked-uri og violated-directive
// så vi kan se hvad der skal whitelistes.

export const config = { runtime: 'edge' };

// Simpel in-memory rate-limit pr. Edge-instans, samme idé som subscribe.js.
// CSP-violations kan komme i bølger (fx fra én browser-extension der
// blokerer scripts), så vi vil gerne undgå at flood Vercel-logs.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30; // max 30 reports/min/IP
const ipReports = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const arr = (ipReports.get(ip) || []).filter(ts => ts > cutoff);
  if (arr.length >= RATE_LIMIT_MAX) return false;
  arr.push(now);
  ipReports.set(ip, arr);
  if (ipReports.size > 5000) {
    for (const [k, v] of ipReports) {
      if (!v.some(ts => ts > cutoff)) ipReports.delete(k);
    }
  }
  return true;
}

function getClientIp(req) {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'unknown';
}

export default async function handler(req) {
  // Browsere sender altid POST til report-endpoints
  if (req.method !== 'POST') {
    return new Response(null, { status: 405 });
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return new Response(null, { status: 429 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(null, { status: 400 });
  }

  // Normaliser begge formater til ét logning-objekt
  const reports = [];

  // Format 1: report-uri — { "csp-report": { ... } }
  if (body && body['csp-report']) {
    const r = body['csp-report'];
    reports.push({
      blockedUri: r['blocked-uri'] || '',
      violatedDirective: r['violated-directive'] || '',
      documentUri: r['document-uri'] || '',
      sourceFile: r['source-file'] || '',
      lineNumber: r['line-number'] || null,
      disposition: r.disposition || 'report',
    });
  }

  // Format 2: report-to — array af { type, body, age, url, user_agent }
  if (Array.isArray(body)) {
    for (const item of body) {
      if (item && item.type === 'csp-violation' && item.body) {
        reports.push({
          blockedUri: item.body.blockedURL || '',
          violatedDirective: item.body.effectiveDirective || '',
          documentUri: item.body.documentURL || item.url || '',
          sourceFile: item.body.sourceFile || '',
          lineNumber: item.body.lineNumber || null,
          disposition: item.body.disposition || 'report',
        });
      }
    }
  }

  // Log struktureret — Vercel viser console.log som queryable logs
  for (const r of reports) {
    console.log('[CSP-VIOLATION]', JSON.stringify(r));
  }

  // 204 No Content — browseren forventer ikke svar-body
  return new Response(null, { status: 204 });
}
