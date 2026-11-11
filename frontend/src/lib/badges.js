// The two numbers in the page header: unread notifications and unread messages.
//
// They live under different query keys (so that reading a notification refreshes one and reading
// a message the other), but the server answers both in one request. Calls made while a request is
// under way share it, so the timer that refreshes both costs one round trip, not two.
import { api } from './api.js';

let underWay = null;

export function fetchBadges() {
  if (!underWay) {
    underWay = api.get('/notifications/badges').finally(() => {
      underWay = null;
    });
  }
  return underWay;
}
