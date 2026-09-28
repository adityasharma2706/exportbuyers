// M39 #2 — k6 load test (LLD M39 #2): "50 RPS search for 10 minutes with p95 < 1.5 s."
//
// Run with the k6 binary (not Node — this file is plain JS on purpose: k6's `k6`/`k6/http`
// module specifiers only resolve inside the k6 runtime, so it is deliberately excluded from
// this workspace's tsc project, the same way apps/web/tsconfig*.json only include **/*.ts):
//
//   BASE_URL=https://staging.exportbuyers.example k6 run apps/web/loadtest/m39-search.k6.js
//
// Targets the same POST /api/buyers/search endpoint the Playwright suite (m39-launch.spec.ts)
// checks per-request; this script checks it holds the budget under sustained load.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const searchLatency = new Trend('buyer_search_duration_ms', true);
const searchFailureRate = new Rate('buyer_search_failures');

// Constant 50 RPS for 10 minutes (LLD M39 #2), with a short ramp so the target rate is not hit
// as an instant step against a cold server.
export const options = {
  scenarios: {
    steady_search_load: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 300,
      stages: [
        { target: 50, duration: '30s' }, // ramp up
        { target: 50, duration: '10m' }, // LLD M39 #2: 50 RPS for 10 minutes
        { target: 0, duration: '15s' }, // ramp down
      ],
    },
  },
  thresholds: {
    // LLD M39 #2: "p95 < 1.5 s".
    buyer_search_duration_ms: ['p(95)<1500'],
    buyer_search_failures: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
  },
};

const COUNTRIES = ['US', 'GB', 'DE', 'AE', 'SG'];
const HEADINGS = ['5208', '6109', '8471', '3004', '7113'];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function search() {
  const payload = JSON.stringify({
    countries: [pick(COUNTRIES)],
    hsHeadings: [pick(HEADINGS)],
    page: 1,
    pageSize: 20,
  });
  const res = http.post(`${BASE_URL}/api/buyers/search`, payload, {
    headers: { 'content-type': 'application/json' },
    tags: { name: 'buyer_search' },
  });
  searchLatency.add(res.timings.duration);
  const ok = check(res, {
    // Anonymous preview responses are 200; a malformed default query is a client-shaped 400, not
    // a server failure, so both are treated as "the server answered", only 5xx/timeouts fail.
    'status is not a server error': (r) => r.status > 0 && r.status < 500,
  });
  searchFailureRate.add(!ok);
  sleep(0.1);
}
