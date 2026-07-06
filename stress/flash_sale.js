import http from 'k6/http';
import { check, sleep } from 'k6';

// k6 Options simulating Flash Sale load.
// Stages scale up from 0 to 100, 500, and 1000 Virtual Users (VUs)
export const options = {
  stages: [
    { duration: '20s', target: 200 },   // Warm-up
    { duration: '30s', target: 500 },   // Ramp-up
    { duration: '30s', target: 1000 },  // Mid-ramp
    { duration: '180s', target: 1000 }, // Peak Flash Sale: 3 phút full 1000 VUs
    { duration: '40s', target: 0 },     // Cool-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<50'], // 95% of requests must complete below 50ms
    http_req_failed: ['rate<0.01'],  // Error rate must be less than 1%
  },
};

// Helper function to verify Luhn algorithm in JS
function verifyLuhn(number) {
  if (!number || number.length !== 14) return false;
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let digit = parseInt(number.charAt(i), 10);
    if (isNaN(digit)) return false;
    // For 14 digits, index 0 is at pos 14 (even), index 13 is at pos 1 (odd, check digit)
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export default function () {
  // Simulate 16 sources (generator-0 to generator-15)
  const port = 8080 + (__VU % 16);
  const url = `http://localhost:${port}/generate`;
  const payload = JSON.stringify({});
  const params = {
    headers: {
      'Content-Type': 'application/json',
    },
  };

  // Simple retry on failure (max 2 retries)
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = http.post(url, payload, params);
    if (res.status === 200) break;
    sleep(0.001);
  }

  const body = JSON.parse(res.body);
  const isOk = check(res, {
    'status is 200': (r) => r.status === 200,
    'has order_number': () => body && typeof body.order_number === 'string',
    'is 14 digits': () => body.order_number && body.order_number.length === 14,
    'passes Luhn check': () => verifyLuhn(body.order_number),
  });

  // Short sleep to simulate real user typing or client delays
  sleep(0.01);
}
