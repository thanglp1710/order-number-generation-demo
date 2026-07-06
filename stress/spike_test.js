import http from 'k6/http';
import { check, sleep } from 'k6';

// Spike test — simulates a real flash-sale "drop": traffic jumps from ~idle
// to peak in seconds, not the gradual 80s ramp flash_sale.js uses. Runs the
// spike TWICE to also observe recovery: does the cluster return to normal
// latency/RPS in the idle gap, or does the first spike leave residual queue
// depth that makes the second spike worse?
//
// Watch live in Grafana (http://localhost:3030/d/order-number-generator) —
// the "RPS per node" and latency panels should show two sharp square-wave
// pulses rather than the smooth ramp/plateau shape of flash_sale.js.

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: 1000 },  // sudden burst — near-instant, not a ramp
        { duration: '30s', target: 1000 }, // hold the spike
        { duration: '5s', target: 0 },     // sudden drop
        { duration: '20s', target: 0 },    // idle gap — does the system fully recover?
        { duration: '5s', target: 1000 },  // second spike
        { duration: '30s', target: 1000 },
        { duration: '5s', target: 0 },     // sudden drop
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const port = 8080 + (__VU % 16);
  const url = `http://localhost:${port}/generate`;

  const res = http.post(url, '{}', {
    headers: { 'Content-Type': 'application/json' },
    timeout: '5s',
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'did not time out': (r) => r.status !== 0,
  });

  sleep(0.01);
}
