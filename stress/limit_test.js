import http from 'k6/http';
import { check } from 'k6';

// Limit test: hammer a SINGLE node (generator-0, port 8080) with no think-time,
// to find the real sustained throughput ceiling of one Worker and confirm it
// matches the theoretical design limit of 16 IDs / 20ms ~= 800 req/s.
export const options = {
  scenarios: {
    single_node_saturation: {
      executor: 'constant-vus',
      vus: 100,
      duration: '20s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.post('http://localhost:8080/generate', '{}', {
    headers: { 'Content-Type': 'application/json' },
  });
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
}
