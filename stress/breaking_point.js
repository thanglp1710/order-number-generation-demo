import http from 'k6/http';
import { check, sleep } from 'k6';

// Finds the real breaking point of the cluster.
//
// The backend deliberately QUEUES excess requests (mutex + spin-wait) instead
// of rejecting them, so it will never return HTTP errors just because it's
// overloaded — flash_sale.js already proved that up to ~10K req/s (79% of the
// 12,800 req/s theoretical cap). To find where it actually "breaks", we push
// well past that cap (up to 5,000 VUs) and set an explicit client-side
// request timeout: a request that takes longer than that timeout IS the
// meaningful failure signal for this design, because the backend will never
// self-report an error.
//
// Watch this run live in Grafana (http://localhost:3030/d/order-number-generator)
// to see exactly which VU level the RPS curve stops climbing and latency
// starts growing unbounded instead of plateauing.

const REQUEST_TIMEOUT = '5s';

export const options = {
  scenarios: {
    breaking_point: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 500 },   // baseline, known-good territory
        { duration: '30s', target: 1000 },  // matches flash_sale.js peak (~79% of cap)
        { duration: '30s', target: 1500 },  // ~117% of theoretical cap (16 x 800)
        { duration: '30s', target: 2000 },
        { duration: '30s', target: 3000 },
        { duration: '30s', target: 4000 },
        { duration: '30s', target: 5000 },
        { duration: '90s', target: 5000 },  // hold at the extreme to see if it stabilizes or collapses
        { duration: '30s', target: 0 },     // ramp down
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    // Informational only — deliberately NOT meant to pass. We want to see
    // exactly where http_req_failed starts climbing, not stop the test early.
    http_req_failed: ['rate<1'],
  },
};

export default function () {
  const port = 8080 + (__VU % 16);
  const url = `http://localhost:${port}/generate`;

  const res = http.post(url, '{}', {
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    // k6 marks a request that hit the timeout/was aborted with status 0 —
    // that's the real "breaking point" signal for a design that queues
    // instead of rejecting.
    'did not time out': (r) => r.status !== 0,
  });

  sleep(0.01);
}
