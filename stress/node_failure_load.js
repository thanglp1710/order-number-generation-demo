import http from 'k6/http';
import { check, sleep } from 'k6';

// Sustained, moderate-high load (not extreme) held flat for ~3.3 minutes, so
// there's a clean "before / during / after" window for node_failure_test.sh
// to kill and restore one node in the middle of the run.
//
// IMPORTANT: this script picks a node per-VU with a FIXED formula
// (port = 8080 + VU % 16) and does NOT retry against a different node on
// failure — on purpose. That's the honest behavior of this demo (no load
// balancer / service mesh in front of the 16 nodes), so killing generator-3
// should visibly fail ~1/16 of requests (whichever VUs are pinned to port
// 8083) for as long as it's down, while the other 15/16 keep working fine.
// A real production deployment would put a load balancer in front of the
// cluster to fail over automatically — this script deliberately does not
// simulate that, to make the blast radius of a single node loss visible.

export const options = {
  scenarios: {
    node_failure: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 800 },  // ramp up to steady state
        { duration: '160s', target: 800 }, // hold flat — node_failure_test.sh kills/restores a node during this window
        { duration: '20s', target: 0 },    // ramp down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // Informational — we expect a real, visible bump around the node-down
    // window; the point of this test is to measure it, not to gate on it.
    http_req_failed: ['rate<1'],
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
